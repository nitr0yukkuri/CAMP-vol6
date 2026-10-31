#!/usr/bin/env python3
"""Convert the local Mendeley YOLO labels to grouped COCO and optionally train.

The --prepare-only path intentionally uses only Python's standard library and
Pillow, so the split and annotations can be inspected before installing ML
dependencies. Model Maker itself is an experimental, deprecated dependency.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import re
import shutil
import statistics
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "data" / "raw" / "mendeley-head-tail" / "extracted"
DEFAULT_GENERATED = PROJECT_ROOT / "ml" / "generated"
VALIDATION_DAYS = {"20191014"}
TEST_DAYS = {"20191114"}
CLASS_NAMES = {0: "head", 1: "tail"}
APP_MAX_RESULTS = 12
DIAGNOSTIC_MAX_RESULTS = 100
IMAGE_NAME_PATTERN = re.compile(r"^IMG_(\d{8})_\d{6}$")


def capture_day(image_path: Path) -> str:
    match = IMAGE_NAME_PATTERN.match(image_path.stem)
    return match.group(1) if match else "other"


def split_for_day(day: str) -> str:
    if day in VALIDATION_DAYS:
        return "validation"
    if day in TEST_DAYS:
        return "test"
    return "train"


def parse_yolo_label(label_path: Path, image_width: int, image_height: int) -> list[dict[str, Any]]:
    annotations = []
    for line_number, raw_line in enumerate(label_path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue

        columns = line.split()
        if len(columns) != 5:
            raise ValueError(f"{label_path}:{line_number}: expected 5 YOLO columns")

        try:
            class_id = int(columns[0])
            center_x, center_y, box_width, box_height = map(float, columns[1:])
        except ValueError as error:
            raise ValueError(f"{label_path}:{line_number}: invalid YOLO values") from error

        if class_id not in CLASS_NAMES:
            raise ValueError(f"{label_path}:{line_number}: unsupported class id {class_id}")
        if not all(0 <= value <= 1 for value in (center_x, center_y, box_width, box_height)):
            raise ValueError(f"{label_path}:{line_number}: normalized value outside [0, 1]")
        if box_width <= 0 or box_height <= 0:
            raise ValueError(f"{label_path}:{line_number}: zero-area box")

        # Decimal rounding in the source can put edge-touching boxes a fraction
        # of a pixel outside the frame. Clip to the actual image dimensions.
        x_min = max(0.0, (center_x - box_width / 2) * image_width)
        y_min = max(0.0, (center_y - box_height / 2) * image_height)
        x_max = min(float(image_width), (center_x + box_width / 2) * image_width)
        y_max = min(float(image_height), (center_y + box_height / 2) * image_height)
        clipped_width = x_max - x_min
        clipped_height = y_max - y_min
        if clipped_width <= 0 or clipped_height <= 0:
            raise ValueError(f"{label_path}:{line_number}: box is outside the image")

        annotations.append({
            "category_id": class_id + 1,  # COCO category 0 is reserved for background.
            "bbox": [x_min, y_min, clipped_width, clipped_height],
            "area": clipped_width * clipped_height,
            "iscrowd": 0,
        })

    return annotations


def prepare_dataset(source_root: Path, generated_root: Path, force: bool) -> dict[str, Any]:
    source_root = source_root.resolve()
    generated_root = generated_root.resolve()
    output_root = (generated_root / "coco").resolve()

    try:
        output_root.relative_to(generated_root)
    except ValueError as error:
        raise ValueError(f"Generated dataset path must stay under {generated_root}") from error

    if output_root.exists():
        if not force:
            raise FileExistsError(f"{output_root} already exists; pass --force to replace generated output")
        shutil.rmtree(output_root)

    all_images = []
    for source_split in ("Training", "Testing"):
        split_dir = source_root / source_split
        if not split_dir.is_dir():
            raise FileNotFoundError(f"Missing source split: {split_dir}")
        all_images.extend((source_split, image_path) for image_path in sorted(split_dir.glob("*.jpg")))

    if not all_images:
        raise FileNotFoundError(f"No JPG images found under {source_root}")

    output_root.mkdir(parents=True, exist_ok=True)
    accumulators: dict[str, dict[str, Any]] = {}
    manifest_rows = []

    for split_name in ("train", "validation", "test"):
        split_root = output_root / split_name
        (split_root / "images").mkdir(parents=True, exist_ok=True)
        accumulators[split_name] = {
            "images": [],
            "annotations": [],
            "class_counts": Counter(),
        }

    for image_id, (source_split, image_path) in enumerate(all_images, 1):
        day = capture_day(image_path)
        target_split = split_for_day(day)
        source_label = image_path.with_suffix(".txt")
        if not source_label.is_file():
            raise FileNotFoundError(f"Missing YOLO label: {source_label}")

        with Image.open(image_path) as image:
            image_width, image_height = image.size

        target_name = f"{source_split.lower()}_{image_path.name}"
        target_image = output_root / target_split / "images" / target_name
        shutil.copy2(image_path, target_image)

        bucket = accumulators[target_split]
        local_image_id = len(bucket["images"]) + 1
        bucket["images"].append({
            "id": local_image_id,
            "file_name": target_name,
            "width": image_width,
            "height": image_height,
        })

        for annotation in parse_yolo_label(source_label, image_width, image_height):
            annotation_id = len(bucket["annotations"]) + 1
            bucket["annotations"].append({
                "id": annotation_id,
                "image_id": local_image_id,
                **annotation,
            })
            bucket["class_counts"][CLASS_NAMES[annotation["category_id"] - 1]] += 1

        manifest_rows.append({
            "generated_split": target_split,
            "capture_day_group": day,
            "source_split": source_split,
            "source_image": str(image_path.relative_to(source_root)).replace("\\", "/"),
            "generated_image": target_name,
        })

    categories = [{"id": index + 1, "name": CLASS_NAMES[index]} for index in sorted(CLASS_NAMES)]
    summary: dict[str, Any] = {
        "source": str(source_root),
        "split_method": "capture_day_group_holdout",
        "validation_days": sorted(VALIDATION_DAYS),
        "test_days": sorted(TEST_DAYS),
        "splits": {},
    }

    for split_name, bucket in accumulators.items():
        split_root = output_root / split_name
        payload = {
            "info": {"description": "Mendeley head/tail detection converted from YOLO to COCO"},
            "licenses": [],
            "images": bucket["images"],
            "annotations": bucket["annotations"],
            "categories": categories,
        }
        (split_root / "labels.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        summary["splits"][split_name] = {
            "images": len(bucket["images"]),
            "annotations": len(bucket["annotations"]),
            "class_counts": dict(sorted(bucket["class_counts"].items())),
        }

    manifest_path = generated_root / "split-manifest.json"
    generated_root.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    summary["generated_root"] = str(generated_root)
    (generated_root / "prepare-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return summary


def train_model(generated_root: Path, output_root: Path) -> dict[str, Any]:
    if not (sys.version_info >= (3, 8) and sys.version_info < (3, 11)):
        raise RuntimeError(
            "MediaPipe Model Maker 0.2.1.4 is documented/classified for Python 3.8–3.10. "
            f"This interpreter is {sys.version_info.major}.{sys.version_info.minor}; use Python 3.10."
        )

    try:
        from mediapipe_model_maker import object_detector
    except ImportError as error:
        raise RuntimeError(
            "Training dependency missing. In a Python 3.10 virtual environment, "
            "install ml/requirements-model-maker.txt."
        ) from error

    dataset_root = generated_root / "coco"
    output_root.mkdir(parents=True, exist_ok=True)
    train_data = object_detector.Dataset.from_coco_folder(
        str(dataset_root / "train"), cache_dir=str(generated_root / "cache" / "train")
    )
    validation_data = object_detector.Dataset.from_coco_folder(
        str(dataset_root / "validation"), cache_dir=str(generated_root / "cache" / "validation")
    )
    test_data = object_detector.Dataset.from_coco_folder(
        str(dataset_root / "test"), cache_dir=str(generated_root / "cache" / "test")
    )

    options = object_detector.ObjectDetectorOptions(
        supported_model=object_detector.SupportedModels.MOBILENET_V2_I320,
        hparams=object_detector.HParams(
            export_dir=str(output_root),
            batch_size=4,
            epochs=30,
        ),
    )
    model = object_detector.ObjectDetector.create(
        train_data=train_data,
        validation_data=validation_data,
        options=options,
    )

    validation_loss, validation_metrics = model.evaluate(validation_data, batch_size=4)
    test_loss, test_metrics = model.evaluate(test_data, batch_size=4)
    model.export_model(model_name="head-tail.tflite")

    report = evaluate_exported_detector(generated_root, output_root)
    report.update({
        "validation_loss": float_or_list(validation_loss),
        "validation_metrics": {key: float(value) for key, value in validation_metrics.items()},
        "test_loss": float_or_list(test_loss),
        "test_metrics": {key: float(value) for key, value in test_metrics.items()},
    })
    (output_root / "metrics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def float_or_list(value: Any) -> float | list[float]:
    if isinstance(value, (list, tuple)):
        return [float(item) for item in value]
    return float(value)


def evaluate_exported_detector(generated_root: Path, output_root: Path) -> dict[str, Any]:
    """Check a saved model with MediaPipe and report validation/test metrics."""
    dataset_root = generated_root / "coco"
    model_path = output_root / "head-tail.tflite"
    sample_images = sorted((dataset_root / "test" / "images").glob("*.jpg"))
    if not sample_images:
        raise FileNotFoundError("No held-out image is available for the MediaPipe compatibility check")

    validation_predictions = collect_exported_predictions(
        model_path, dataset_root / "validation", max_results=APP_MAX_RESULTS
    )
    threshold_calibration = calibrate_score_threshold(validation_predictions)
    compatibility = verify_exported_model(
        model_path,
        sample_images[0],
        score_threshold=threshold_calibration["selected_score_threshold"],
        max_results=APP_MAX_RESULTS,
    )
    test_predictions = collect_exported_predictions(
        model_path, dataset_root / "test", max_results=APP_MAX_RESULTS
    )
    held_out_detection_metrics = evaluate_detections(
        test_predictions,
        threshold_calibration["selected_score_threshold"],
    )
    held_out_detection_metrics["coco_average_precision"] = evaluate_coco_average_precision(test_predictions)
    error_analysis = analyze_detection_errors(
        test_predictions,
        threshold_calibration["selected_score_threshold"],
    )
    test_inference_ms = sorted(image["inference_ms"] for image in test_predictions)
    p95_index = min(len(test_inference_ms) - 1, max(0, math.ceil(len(test_inference_ms) * 0.95) - 1))

    # Compare against a generous result cap to reveal whether the browser's
    # configured output limit suppresses otherwise available detections.
    high_cap_predictions = collect_exported_predictions(
        model_path, dataset_root / "test", max_results=DIAGNOSTIC_MAX_RESULTS
    )
    high_cap_metrics = evaluate_detections(
        high_cap_predictions,
        threshold_calibration["selected_score_threshold"],
    )
    high_cap_metrics["coco_average_precision"] = evaluate_coco_average_precision(high_cap_predictions)
    error_montage_path = output_root / "error-analysis.png"
    error_montage_summary = render_error_montage(
        test_predictions,
        threshold_calibration["selected_score_threshold"],
        dataset_root / "test" / "images",
        error_montage_path,
    )

    web_model_path = PROJECT_ROOT / "apps" / "web" / "public" / "models" / "head-tail.tflite"
    web_model_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(model_path, web_model_path)

    report_path = output_root / "metrics.json"
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.is_file() else {}
    summary_path = generated_root / "prepare-summary.json"
    dataset_summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.is_file() else {}
    try:
        mediapipe_version = importlib.metadata.version("mediapipe")
    except importlib.metadata.PackageNotFoundError:
        mediapipe_version = "unknown"
    report.update({
        "model": "MediaPipe Model Maker / MobileNetV2 I320",
        "model_path": str(model_path),
        "model_bytes": model_path.stat().st_size,
        "model_sha256": sha256_file(model_path),
        "web_model_path": str(web_model_path),
        "evaluation_runtime": {
            "mediapipe": mediapipe_version,
            "python": platform.python_version(),
            "browser_max_results": APP_MAX_RESULTS,
            "browser_score_threshold": threshold_calibration["selected_score_threshold"],
        },
        "dataset_split": {
            "method": dataset_summary.get("split_method"),
            "validation_days": dataset_summary.get("validation_days", []),
            "test_days": dataset_summary.get("test_days", []),
            "splits": dataset_summary.get("splits", {}),
            "label_sha256": {
                name: sha256_file(dataset_root / name / "labels.json")
                for name in ("train", "validation", "test")
                if (dataset_root / name / "labels.json").is_file()
            },
        },
        "compatibility_smoke_test": compatibility,
        "threshold_calibration": threshold_calibration,
        "held_out_detection_metrics": held_out_detection_metrics,
        "held_out_error_analysis": error_analysis,
        "visual_error_analysis": {
            "path": str(error_montage_path),
            **error_montage_summary,
        },
        "max_results_sensitivity": {
            "browser_limit": APP_MAX_RESULTS,
            "diagnostic_limit": DIAGNOSTIC_MAX_RESULTS,
            "browser_metrics": held_out_detection_metrics,
            "diagnostic_metrics": high_cap_metrics,
            "note": "Both metrics use the score threshold calibrated on validation with the browser limit.",
        },
        "cpu_inference_latency_ms": {
            "images": len(test_inference_ms),
            "median": round(statistics.median(test_inference_ms), 2),
            "p95": round(test_inference_ms[p95_index], 2),
            "runtime": "MediaPipe Tasks Python / TFLite XNNPACK CPU; includes image decode",
        },
        "warning": "Small, public benchmark only. Not a fish-preparation state classifier.",
    })
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_exported_model(
    model_path: Path,
    sample_image: Path,
    score_threshold: float = 0.35,
    max_results: int = APP_MAX_RESULTS,
) -> dict[str, Any]:
    """Load and run the exported artifact through the MediaPipe Tasks API."""
    import mediapipe as mp
    import numpy as np
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    if not model_path.is_file() or model_path.stat().st_size == 0:
        raise FileNotFoundError(f"MediaPipe did not export a usable model: {model_path}")

    image_array = np.array(Image.open(sample_image).convert("RGB"), copy=True)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_array)
    options = vision.ObjectDetectorOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.IMAGE,
        max_results=max_results,
        score_threshold=score_threshold,
        category_allowlist=["head", "tail"],
    )
    detector = vision.ObjectDetector.create_from_options(options)
    try:
        result = detector.detect(mp_image)
    finally:
        detector.close()

    return {
        "runtime": "MediaPipe Tasks Vision ObjectDetector",
        "loadedAndRan": True,
        "sampleImage": sample_image.name,
        "detections": len(result.detections),
        "scoreThreshold": score_threshold,
        "maxResults": max_results,
    }


def collect_exported_predictions(
    model_path: Path,
    split_root: Path,
    max_results: int = APP_MAX_RESULTS,
) -> list[dict[str, Any]]:
    """Run the TFLite model through MediaPipe Tasks and retain COCO ground truth."""
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    labels_path = split_root / "labels.json"
    payload = json.loads(labels_path.read_text(encoding="utf-8"))
    category_names = {category["id"]: category["name"] for category in payload["categories"]}
    annotations_by_image: dict[int, list[dict[str, Any]]] = {}
    for annotation in payload["annotations"]:
        annotations_by_image.setdefault(annotation["image_id"], []).append(annotation)

    options = vision.ObjectDetectorOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.IMAGE,
        max_results=max_results,
        score_threshold=0.001,
        category_allowlist=["head", "tail"],
    )
    detector = vision.ObjectDetector.create_from_options(options)
    predictions: list[dict[str, Any]] = []
    try:
        for image_record in payload["images"]:
            image_path = split_root / "images" / image_record["file_name"]
            inference_started = time.perf_counter()
            result = detector.detect(mp.Image.create_from_file(str(image_path)))
            inference_ms = (time.perf_counter() - inference_started) * 1000
            image_detections = []
            for detection in result.detections:
                category = detection.categories[0] if detection.categories else None
                box = detection.bounding_box
                if category is None or category.category_name not in {"head", "tail"}:
                    continue
                image_detections.append({
                    "label": category.category_name,
                    "score": float(category.score),
                    "box": [float(box.origin_x), float(box.origin_y), float(box.width), float(box.height)],
                })
            predictions.append({
                "image_id": image_record["id"],
                "file_name": image_record["file_name"],
                "width": image_record["width"],
                "height": image_record["height"],
                "inference_ms": inference_ms,
                "ground_truth": [
                    {
                        "label": category_names[annotation["category_id"]],
                        "box": annotation["bbox"],
                    }
                    for annotation in annotations_by_image.get(image_record["id"], [])
                ],
                "detections": image_detections,
            })
    finally:
        detector.close()

    return predictions


def render_error_montage(
    predictions: list[dict[str, Any]],
    score_threshold: float,
    image_root: Path,
    output_path: Path,
    max_images: int = 18,
) -> dict[str, Any]:
    """Render a contact sheet of held-out frames with both labels and predictions."""
    errors = analyze_detection_errors(predictions, score_threshold)
    error_counts = Counter(
        row["image"]
        for row in errors["false_negatives"] + errors["false_positives"]
    )
    if not error_counts:
        return {"images": 0, "rendered": False}

    prediction_by_file = {image["file_name"]: image for image in predictions}
    selected_names = sorted(error_counts, key=lambda name: (-error_counts[name], name))[:max_images]
    columns = 3
    tile_width = 420
    tile_height = 300
    rows = math.ceil(len(selected_names) / columns)
    sheet = Image.new("RGB", (columns * tile_width, rows * tile_height), "#f1f2ef")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    colors = {"head": "#d45b39", "tail": "#167c72"}
    prediction_colors = {"head": "#f2a900", "tail": "#1478c8"}

    for index, file_name in enumerate(selected_names):
        record = prediction_by_file[file_name]
        left = (index % columns) * tile_width
        top = (index // columns) * tile_height
        draw.rectangle((left + 4, top + 4, left + tile_width - 4, top + tile_height - 4), fill="#ffffff", outline="#d6ddd8")
        fn_count = sum(row["image"] == file_name for row in errors["false_negatives"])
        fp_count = sum(row["image"] == file_name for row in errors["false_positives"])
        draw.text((left + 12, top + 10), f"{file_name} | FN {fn_count} / FP {fp_count}", fill="#263a34", font=font)

        image = Image.open(image_root / file_name).convert("RGB")
        image.thumbnail((tile_width - 28, tile_height - 72))
        image_left = left + (tile_width - image.width) // 2
        image_top = top + 32 + (tile_height - 72 - image.height) // 2
        sheet.paste(image, (image_left, image_top))
        scale_x = image.width / record["width"]
        scale_y = image.height / record["height"]

        for row in record["ground_truth"]:
            x, y, width, height = row["box"]
            bounds = (
                image_left + x * scale_x,
                image_top + y * scale_y,
                image_left + (x + width) * scale_x,
                image_top + (y + height) * scale_y,
            )
            draw.rectangle(bounds, outline=colors[row["label"]], width=2)

        for row in record["detections"]:
            if row["score"] < score_threshold:
                continue
            x, y, width, height = row["box"]
            bounds = (
                image_left + x * scale_x,
                image_top + y * scale_y,
                image_left + (x + width) * scale_x,
                image_top + (y + height) * scale_y,
            )
            draw.rectangle(bounds, outline=prediction_colors[row["label"]], width=2)

        draw.text((left + 12, top + tile_height - 28), "GT head/tail = red/green | prediction = yellow/blue", fill="#52625b", font=font)
        image.close()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, format="PNG", optimize=True)
    return {"images": len(selected_names), "rendered": True}


def analyze_detection_errors(
    predictions: list[dict[str, Any]],
    score_threshold: float,
    iou_threshold: float = 0.5,
) -> dict[str, Any]:
    """Expose image-level misses and whether score or localization is the likely issue."""
    false_negatives: list[dict[str, Any]] = []
    false_positives: list[dict[str, Any]] = []
    per_class = {label: {"false_negatives": 0, "false_positives": 0} for label in ("head", "tail")}

    for image in predictions:
        for label in ("head", "tail"):
            ground_truth = [row["box"] for row in image["ground_truth"] if row["label"] == label]
            all_detections = [row for row in image["detections"] if row["label"] == label]
            detections = sorted(
                (row for row in all_detections if row["score"] >= score_threshold),
                key=lambda row: row["score"],
                reverse=True,
            )
            matched: set[int] = set()

            for detection in detections:
                candidates = sorted(
                    ((box_iou(detection["box"], box), index) for index, box in enumerate(ground_truth) if index not in matched),
                    reverse=True,
                )
                if candidates and candidates[0][0] >= iou_threshold:
                    matched.add(candidates[0][1])
                else:
                    best_iou = max((box_iou(detection["box"], box) for box in ground_truth), default=0.0)
                    false_positives.append({
                        "image": image["file_name"],
                        "label": label,
                        "score": round(detection["score"], 4),
                        "box": [round(value, 2) for value in detection["box"]],
                        "best_iou": round(best_iou, 4),
                    })
                    per_class[label]["false_positives"] += 1

            for index, box in enumerate(ground_truth):
                if index in matched:
                    continue
                same_class_candidates = sorted(
                    ((box_iou(detection["box"], box), detection["score"]) for detection in all_detections),
                    reverse=True,
                )
                best_iou, best_score = same_class_candidates[0] if same_class_candidates else (0.0, 0.0)
                other_class_iou = max((
                    box_iou(detection["box"], box)
                    for detection in image["detections"]
                    if detection["label"] != label
                ), default=0.0)
                likely_cause = (
                    "low_score"
                    if best_iou >= iou_threshold and best_score < score_threshold
                    else "localization"
                    if best_iou > 0
                    else "class_confusion"
                    if other_class_iou >= iou_threshold
                    else "missed"
                )
                false_negatives.append({
                    "image": image["file_name"],
                    "label": label,
                    "ground_truth_box": [round(value, 2) for value in box],
                    "best_candidate_score": round(best_score, 4),
                    "best_candidate_iou": round(best_iou, 4),
                    "best_other_class_iou": round(other_class_iou, 4),
                    "likely_cause": likely_cause,
                })
                per_class[label]["false_negatives"] += 1

    return {
        "iou_threshold": iou_threshold,
        "score_threshold": score_threshold,
        "miss_causes": {
            "low_score": "candidate overlaps the label but falls below the score threshold",
            "localization": "candidate overlaps the label but not enough for the IoU threshold",
            "class_confusion": "an opposite-class box overlaps the label at the IoU threshold",
            "missed": "no same-class candidate overlaps the label",
        },
        "per_class": per_class,
        "false_negatives": false_negatives,
        "false_positives": false_positives,
    }


def box_iou(first: list[float], second: list[float]) -> float:
    first_x1, first_y1, first_width, first_height = first
    second_x1, second_y1, second_width, second_height = second
    intersection_x1 = max(first_x1, second_x1)
    intersection_y1 = max(first_y1, second_y1)
    intersection_x2 = min(first_x1 + first_width, second_x1 + second_width)
    intersection_y2 = min(first_y1 + first_height, second_y1 + second_height)
    intersection = max(0.0, intersection_x2 - intersection_x1) * max(0.0, intersection_y2 - intersection_y1)
    union = first_width * first_height + second_width * second_height - intersection
    return intersection / union if union > 0 else 0.0


def evaluate_detections(predictions: list[dict[str, Any]], score_threshold: float) -> dict[str, Any]:
    """Greedy per-class matching at IoU 0.5 for interpretable small-set metrics."""
    labels = ("head", "tail")
    counts = {label: {"true_positives": 0, "false_positives": 0, "false_negatives": 0} for label in labels}

    for image in predictions:
        for label in labels:
            ground_truth = [row["box"] for row in image["ground_truth"] if row["label"] == label]
            detections = sorted(
                (row for row in image["detections"] if row["label"] == label and row["score"] >= score_threshold),
                key=lambda row: row["score"],
                reverse=True,
            )
            matched: set[int] = set()
            for detection in detections:
                candidates = sorted(
                    ((box_iou(detection["box"], box), index) for index, box in enumerate(ground_truth) if index not in matched),
                    reverse=True,
                )
                if candidates and candidates[0][0] >= 0.5:
                    matched.add(candidates[0][1])
                    counts[label]["true_positives"] += 1
                else:
                    counts[label]["false_positives"] += 1
            counts[label]["false_negatives"] += len(ground_truth) - len(matched)

    per_class: dict[str, Any] = {}
    f1_values = []
    for label, row in counts.items():
        precision = row["true_positives"] / max(1, row["true_positives"] + row["false_positives"])
        recall = row["true_positives"] / max(1, row["true_positives"] + row["false_negatives"])
        f1 = 2 * precision * recall / max(1e-12, precision + recall)
        per_class[label] = {
            **row,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
        }
        f1_values.append(f1)

    return {
        "images": len(predictions),
        "score_threshold": score_threshold,
        "iou_threshold": 0.5,
        "matching": "per-image greedy, one-to-one, same class",
        "per_class": per_class,
        "macro_f1": round(sum(f1_values) / len(f1_values), 4),
    }


def evaluate_coco_average_precision(predictions: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute class-macro 101-point AP from the exported detector's detections."""
    labels = ("head", "tail")
    iou_thresholds = [round(0.5 + offset * 0.05, 2) for offset in range(10)]
    per_class: dict[str, dict[str, float]] = {}

    for label in labels:
        ground_truth_by_image = {
            image["image_id"]: [row["box"] for row in image["ground_truth"] if row["label"] == label]
            for image in predictions
        }
        total_ground_truth = sum(len(boxes) for boxes in ground_truth_by_image.values())
        detections = sorted(
            (
                (row["score"], image["image_id"], row["box"])
                for image in predictions
                for row in image["detections"]
                if row["label"] == label
            ),
            key=lambda row: row[0],
            reverse=True,
        )
        label_ap: dict[str, float] = {}

        for iou_threshold in iou_thresholds:
            matched_by_image: dict[int, set[int]] = {}
            true_positives: list[int] = []
            false_positives: list[int] = []
            for _, image_id, detected_box in detections:
                ground_truth_boxes = ground_truth_by_image[image_id]
                matched = matched_by_image.setdefault(image_id, set())
                candidates = sorted(
                    ((box_iou(detected_box, box), index) for index, box in enumerate(ground_truth_boxes) if index not in matched),
                    reverse=True,
                )
                if candidates and candidates[0][0] >= iou_threshold:
                    matched.add(candidates[0][1])
                    true_positives.append(1)
                    false_positives.append(0)
                else:
                    true_positives.append(0)
                    false_positives.append(1)

            cumulative_true = 0
            cumulative_false = 0
            recalls = []
            precisions = []
            for true_positive, false_positive in zip(true_positives, false_positives):
                cumulative_true += true_positive
                cumulative_false += false_positive
                recalls.append(cumulative_true / max(1, total_ground_truth))
                precisions.append(cumulative_true / max(1, cumulative_true + cumulative_false))

            interpolated_precision = [
                max((precision for recall, precision in zip(recalls, precisions) if recall >= threshold), default=0.0)
                for threshold in [index / 100 for index in range(101)]
            ]
            label_ap[f"AP{int(iou_threshold * 100)}"] = sum(interpolated_precision) / len(interpolated_precision)

        per_class[label] = {key: round(value, 4) for key, value in label_ap.items()}

    return {
        "images": len(predictions),
        "iou_thresholds": iou_thresholds,
        "per_class": per_class,
        "AP50": round(sum(per_class[label]["AP50"] for label in labels) / len(labels), 4),
        "AP50_95": round(
            sum(value for label in labels for value in per_class[label].values())
            / (len(labels) * len(iou_thresholds)),
            4,
        ),
    }


def calibrate_score_threshold(validation_predictions: list[dict[str, Any]]) -> dict[str, Any]:
    thresholds = [round(value / 100, 2) for value in range(5, 96, 5)]
    candidate_metrics = [evaluate_detections(validation_predictions, threshold) for threshold in thresholds]
    selected = max(candidate_metrics, key=lambda metrics: (metrics["macro_f1"], metrics["score_threshold"]))
    return {
        "dataset_split": "validation",
        "selection_metric": "macro_f1_at_iou_0.5",
        "selected_score_threshold": selected["score_threshold"],
        "selected_metrics": selected,
        "candidates": candidate_metrics,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Mendeley extracted root")
    parser.add_argument("--generated", type=Path, default=DEFAULT_GENERATED, help="Ignored generated data directory")
    parser.add_argument("--prepare-only", action="store_true", help="Convert annotations and print split counts only")
    parser.add_argument("--evaluate-only", action="store_true", help="Check and evaluate an existing exported model without retraining")
    parser.add_argument("--force", action="store_true", help="Replace only the generated COCO conversion")
    args = parser.parse_args()

    if args.evaluate_only:
        report = evaluate_exported_detector(args.generated.resolve(), (args.generated / "output").resolve())
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    summary = prepare_dataset(args.source, args.generated, force=args.force)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not args.prepare_only:
        report = train_model(args.generated.resolve(), (args.generated / "output").resolve())
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
