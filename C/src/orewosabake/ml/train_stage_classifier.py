"""Train and evaluate one fish-specific MediaPipe image-classifier model."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import math
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
GENERATED_ROOT = PROJECT_ROOT / "ml" / "generated" / "fish-stage"
STAGE_LABELS = {"whole", "head_removed", "gutted", "filleting", "finished"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
TRANSITION_CONFIDENCE_THRESHOLD = 0.70
TRANSITION_STABLE_FRAMES = 3
TRANSITION_MAX_FRAME_GAP_MS = 2_500
TRANSITION_MAX_DELAY_MS = 8_000


def image_files(data_root: Path, split: str) -> list[tuple[Path, str]]:
    rows: list[tuple[Path, str]] = []
    for label_dir in sorted(path for path in (data_root / split).iterdir() if path.is_dir()):
        for path in sorted(label_dir.iterdir()):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                rows.append((path, label_dir.name))
    return rows


def counts_for(predictions: list[tuple[str, str]], labels: list[str]) -> dict[str, object]:
    confusion: dict[str, Counter[str]] = {label: Counter() for label in labels}
    for truth, predicted in predictions:
        confusion.setdefault(truth, Counter())[predicted] += 1

    metrics: dict[str, dict[str, float | int]] = {}
    total = len(predictions)
    correct = sum(counts.get(label, 0) for label, counts in confusion.items())
    for label in labels:
        true_positive = confusion.get(label, Counter()).get(label, 0)
        support = sum(confusion.get(label, Counter()).values())
        predicted_total = sum(counts.get(label, 0) for counts in confusion.values())
        precision = true_positive / predicted_total if predicted_total else 0.0
        recall = true_positive / support if support else 0.0
        metrics[label] = {
            "support": support,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0,
        }

    matrix = {
        truth: {predicted: confusion.get(truth, Counter()).get(predicted, 0) for predicted in [*labels, "unrecognized"]}
        for truth in labels
    }
    return {
        "images": total,
        "accuracy": round(correct / total, 4) if total else 0.0,
        "per_class": metrics,
        "confusion_matrix": matrix,
    }


def paths_overlap(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def evaluate_video_transitions(mp: object, model_path: Path, data_root: Path) -> dict[str, object]:
    samples_manifest = data_root / "stage-samples.csv"
    if not samples_manifest.is_file():
        return {
            "status": "missing_sequence_manifest",
            "reason": "Rebuild the dataset with prepare_stage_capture.py to preserve session timestamps.",
        }

    by_sequence: dict[tuple[str, str], list[dict[str, object]]] = {}
    excluded_rows = Counter()
    with samples_manifest.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"split", "fish_id", "session_id", "relative_time_ms", "stage", "image_path"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            return {"status": "invalid_sequence_manifest", "reason": "stage-samples.csv is missing sequence columns."}
        for row in reader:
            if row.get("split", "").strip() != "test":
                continue
            fish_id = row.get("fish_id", "").strip()
            session_id = row.get("session_id", "").strip()
            stage = row.get("stage", "").strip()
            image_path_value = row.get("image_path", "").strip()
            try:
                captured_at_ms = int(row.get("relative_time_ms", "").strip())
            except (TypeError, ValueError):
                excluded_rows["missing_or_invalid_timestamp"] += 1
                continue
            if not fish_id or not session_id or stage not in STAGE_LABELS or captured_at_ms < 0 or not image_path_value:
                excluded_rows["invalid_sequence_fields"] += 1
                continue
            image_path = (data_root / image_path_value).resolve()
            try:
                image_path.relative_to(data_root.resolve())
            except ValueError:
                excluded_rows["path_outside_dataset"] += 1
                continue
            if not image_path.is_file():
                excluded_rows["missing_image"] += 1
                continue
            by_sequence.setdefault((fish_id, session_id), []).append({
                "timestamp_ms": captured_at_ms,
                "stage": stage,
                "image_path": image_path,
            })

    if not by_sequence:
        return {
            "status": "no_usable_test_sequences",
            "excluded_rows": dict(sorted(excluded_rows.items())),
            "reason": "No test frames have both a reviewed stage and a valid timestamp.",
        }

    base_options = mp.tasks.BaseOptions(model_asset_path=str(model_path))
    truth_events: list[dict[str, object]] = []
    predicted_events: list[dict[str, object]] = []
    sequence_count = 0
    usable_frames = 0
    for (fish_id, session_id), frames in sorted(by_sequence.items()):
        frames.sort(key=lambda frame: (frame["timestamp_ms"], str(frame["image_path"])))
        sequence_count += 1
        classifier_options = mp.tasks.vision.ImageClassifierOptions(
            base_options=base_options,
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            max_results=len(STAGE_LABELS),
        )
        classifier = mp.tasks.vision.ImageClassifier.create_from_options(classifier_options)
        previous_truth: str | None = None
        previous_time: int | None = None
        candidate: str | None = None
        candidate_count = 0
        stable: str | None = None
        last_classifier_timestamp = -1
        try:
            for frame in frames:
                timestamp_ms = int(frame["timestamp_ms"])
                truth = str(frame["stage"])
                if previous_time is not None and timestamp_ms - previous_time > TRANSITION_MAX_FRAME_GAP_MS:
                    previous_truth = None
                    candidate = None
                    candidate_count = 0
                    stable = None

                if previous_truth is not None and previous_truth != truth:
                    truth_events.append({
                        "fish_id": fish_id,
                        "session_id": session_id,
                        "from": previous_truth,
                        "to": truth,
                        "timestamp_ms": timestamp_ms,
                    })

                last_classifier_timestamp = max(timestamp_ms, last_classifier_timestamp + 1)
                image = mp.Image.create_from_file(str(frame["image_path"]))
                result = classifier.classify_for_video(image, last_classifier_timestamp)
                categories = [category for group in result.classifications for category in group.categories]
                best = max(categories, key=lambda category: category.score, default=None)
                label = (best.category_name or best.display_name) if best else ""
                score = float(best.score) if best else 0.0
                predicted = label if label in STAGE_LABELS and math.isfinite(score) and score >= TRANSITION_CONFIDENCE_THRESHOLD else None
                usable_frames += 1

                if predicted is None:
                    candidate = None
                    candidate_count = 0
                elif candidate == predicted:
                    candidate_count += 1
                else:
                    candidate = predicted
                    candidate_count = 1

                if predicted is not None and candidate_count >= TRANSITION_STABLE_FRAMES:
                    if stable is not None and stable != predicted:
                        predicted_events.append({
                            "fish_id": fish_id,
                            "session_id": session_id,
                            "from": stable,
                            "to": predicted,
                            "timestamp_ms": timestamp_ms,
                        })
                    stable = predicted

                previous_truth = truth
                previous_time = timestamp_ms
        finally:
            classifier.close()

    unmatched_predictions = set(range(len(predicted_events)))
    delays_ms: list[int] = []
    for truth_event in truth_events:
        matches = [
            index for index in unmatched_predictions
            if predicted_events[index]["fish_id"] == truth_event["fish_id"]
            and predicted_events[index]["session_id"] == truth_event["session_id"]
            and predicted_events[index]["from"] == truth_event["from"]
            and predicted_events[index]["to"] == truth_event["to"]
            and 0 <= int(predicted_events[index]["timestamp_ms"]) - int(truth_event["timestamp_ms"]) <= TRANSITION_MAX_DELAY_MS
        ]
        if matches:
            match = min(matches, key=lambda index: int(predicted_events[index]["timestamp_ms"]))
            unmatched_predictions.remove(match)
            delays_ms.append(int(predicted_events[match]["timestamp_ms"]) - int(truth_event["timestamp_ms"]))

    true_positives = len(delays_ms)
    false_positives = len(unmatched_predictions)
    false_negatives = len(truth_events) - true_positives
    sorted_delays = sorted(delays_ms)
    p95_index = max(0, math.ceil(len(sorted_delays) * 0.95) - 1)
    return {
        "status": "measured" if truth_events else "no_ground_truth_transitions",
        "sequences": sequence_count,
        "usable_frames": usable_frames,
        "ground_truth_transitions": len(truth_events),
        "predicted_transitions": len(predicted_events),
        "matched_transitions": true_positives,
        "false_positives": false_positives,
        "missed_transitions": false_negatives,
        "precision": round(true_positives / len(predicted_events), 4) if predicted_events else 0.0,
        "recall": round(true_positives / len(truth_events), 4) if truth_events else None,
        "mean_detection_delay_ms": round(sum(delays_ms) / len(delays_ms), 1) if delays_ms else None,
        "p95_detection_delay_ms": sorted_delays[p95_index] if sorted_delays else None,
        "settings": {
            "confidence_threshold": TRANSITION_CONFIDENCE_THRESHOLD,
            "stable_frames": TRANSITION_STABLE_FRAMES,
            "max_frame_gap_ms": TRANSITION_MAX_FRAME_GAP_MS,
            "max_detection_delay_ms": TRANSITION_MAX_DELAY_MS,
        },
        "excluded_rows": dict(sorted(excluded_rows.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fish-id", choices=["hamachi", "aji", "saba", "tai"], required=True)
    parser.add_argument("--data", type=Path, default=None, help="prepared train/validation/test folders")
    parser.add_argument("--output", type=Path, default=None, help="model output folder under ml/generated/fish-stage")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--force", action="store_true", help="replace only this fish's generated model folder")
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1:
        parser.error("--epochs and --batch-size must be positive")

    data_root = (args.data or GENERATED_ROOT / args.fish_id / "dataset").resolve()
    output_root = (args.output or GENERATED_ROOT / args.fish_id / "model").resolve()
    generated_root = GENERATED_ROOT.resolve()
    for candidate in (data_root, output_root):
        try:
            candidate.relative_to(generated_root)
        except ValueError:
            parser.error(f"data and output must stay under {generated_root}")
    if data_root == generated_root or output_root == generated_root:
        parser.error("--data and --output must be fish-specific subfolders of the generated root")
    if paths_overlap(data_root, output_root):
        parser.error("--output must not overlap the training data folder")
    if not data_root.is_dir():
        parser.error(f"prepared dataset not found: {data_root}")

    split_files = {split: image_files(data_root, split) for split in ("train", "validation", "test")}
    missing = {
        split: sorted(STAGE_LABELS - {label for _, label in files})
        for split, files in split_files.items()
        if STAGE_LABELS - {label for _, label in files}
    }
    if missing:
        details = "; ".join(f"{split}: {', '.join(labels)}" for split, labels in sorted(missing.items()))
        parser.error(f"each split must contain reviewed images for all five states: {details}")

    expected_labels = {label for _, label in split_files["train"]}
    if expected_labels != STAGE_LABELS:
        parser.error(f"training data must contain exactly these five states: {', '.join(sorted(STAGE_LABELS))}")

    mismatched = [split for split, files in split_files.items() if {label for _, label in files} != STAGE_LABELS]
    if mismatched:
        parser.error(f"train, validation, and test must use the same classes; mismatched split(s): {', '.join(mismatched)}")

    try:
        import mediapipe as mp
        import tensorflow as tf
        from mediapipe_model_maker import image_classifier
    except ImportError as error:
        parser.error(
            "MediaPipe Model Maker is not installed. Use the repository's isolated Python 3.10/WSL training setup; "
            f"details: {error}"
        )
    if not tf.__version__.startswith("2"):
        parser.error(f"TensorFlow 2 is required, found {tf.__version__}")

    if output_root.exists():
        if not args.force:
            parser.error(f"{output_root} already exists; pass --force to replace this generated model")
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    train_data = image_classifier.Dataset.from_folder(str(data_root / "train"))
    validation_data = image_classifier.Dataset.from_folder(str(data_root / "validation"))
    test_data = image_classifier.Dataset.from_folder(str(data_root / "test"))
    if set(train_data.label_names) != expected_labels or set(validation_data.label_names) != expected_labels or set(test_data.label_names) != expected_labels:
        parser.error("MediaPipe Model Maker loaded different class labels across the three splits")

    options = image_classifier.ImageClassifierOptions(
        supported_model=image_classifier.SupportedModels.MOBILENET_V2,
        hparams=image_classifier.HParams(
            epochs=args.epochs,
            batch_size=args.batch_size,
            export_dir=str(output_root),
        ),
    )
    model = image_classifier.ImageClassifier.create(
        train_data=train_data,
        validation_data=validation_data,
        options=options,
    )
    test_loss, test_accuracy = model.evaluate(test_data)
    model.export_model()

    exported_models = sorted(output_root.rglob("*.tflite"))
    if len(exported_models) != 1:
        parser.error(f"expected one exported TFLite model, found {len(exported_models)}")
    model_path = output_root / f"fish-stage-{args.fish_id}.tflite"
    if exported_models[0] != model_path:
        shutil.copy2(exported_models[0], model_path)

    base_options = mp.tasks.BaseOptions(model_asset_path=str(model_path))
    classifier_options = mp.tasks.vision.ImageClassifierOptions(
        base_options=base_options,
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
    )
    classifier = mp.tasks.vision.ImageClassifier.create_from_options(classifier_options)
    predictions: list[tuple[str, str]] = []
    try:
        for image_path, truth in split_files["test"]:
            image = mp.Image.create_from_file(str(image_path))
            result = classifier.classify(image)
            categories = [category for group in result.classifications for category in group.categories]
            best = max(categories, key=lambda category: category.score, default=None)
            predictions.append((truth, best.category_name if best and best.category_name in expected_labels else "unrecognized"))
    finally:
        classifier.close()

    transition_evaluation = evaluate_video_transitions(mp, model_path, data_root)

    report = {
        "fish_id": args.fish_id,
        "runtime": "MediaPipe Tasks Vision ImageClassifier",
        "architecture": "MediaPipe Model Maker MobileNetV2",
        "validation_split": "independent fish/session groups",
        "model": model_path.name,
        "model_bytes": model_path.stat().st_size,
        "labels": sorted(expected_labels),
        "image_counts": {split: len(files) for split, files in split_files.items()},
        "model_maker_test": {"loss": float(test_loss), "accuracy": float(test_accuracy)},
        "mediapipe_tflite_test": counts_for(predictions, sorted(expected_labels)),
        "transition_evaluation": transition_evaluation,
        "groups": "fish_id and session_id never cross the train/validation/test split",
        "promotion": "not copied to the web public model folder; review held-out per-class results before manual promotion",
    }
    report_path = output_root / "stage-model-evaluation.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Exported MediaPipe model: {model_path}")
    print(f"Evaluation report: {report_path}")
    print("Do not promote the model from accuracy alone; inspect per-class errors on the held-out capture groups.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
