#!/usr/bin/env python3
"""Convert the local Mendeley YOLO labels to grouped COCO and optionally train.

The --prepare-only path intentionally uses only Python's standard library and
Pillow, so the split and annotations can be inspected before installing ML
dependencies. Model Maker itself is an experimental, deprecated dependency.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "data" / "raw" / "mendeley-head-tail" / "extracted"
DEFAULT_GENERATED = PROJECT_ROOT / "ml" / "generated"
VALIDATION_DAYS = {"20191014"}
TEST_DAYS = {"20191114"}
CLASS_NAMES = {0: "head", 1: "tail"}
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

    model_path = output_root / "head-tail.tflite"
    sample_images = sorted((dataset_root / "test" / "images").glob("*.jpg"))
    if not sample_images:
        raise FileNotFoundError("No held-out image is available for the MediaPipe compatibility check")
    compatibility = verify_exported_model(model_path, sample_images[0])

    web_model_path = PROJECT_ROOT / "apps" / "web" / "public" / "models" / "head-tail.tflite"
    web_model_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(model_path, web_model_path)

    report = {
        "model": "MediaPipe Model Maker / MobileNetV2 I320",
        "validation_loss": float(validation_loss),
        "validation_metrics": {key: float(value) for key, value in validation_metrics.items()},
        "test_loss": float(test_loss),
        "test_metrics": {key: float(value) for key, value in test_metrics.items()},
        "model_path": str(model_path),
        "web_model_path": str(web_model_path),
        "compatibility_smoke_test": compatibility,
        "warning": "Small, public benchmark only. Not a fish-preparation state classifier.",
    }
    (output_root / "metrics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def verify_exported_model(model_path: Path, sample_image: Path) -> dict[str, Any]:
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
        max_results=12,
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
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Mendeley extracted root")
    parser.add_argument("--generated", type=Path, default=DEFAULT_GENERATED, help="Ignored generated data directory")
    parser.add_argument("--prepare-only", action="store_true", help="Convert annotations and print split counts only")
    parser.add_argument("--force", action="store_true", help="Replace only the generated COCO conversion")
    args = parser.parse_args()

    summary = prepare_dataset(args.source, args.generated, force=args.force)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not args.prepare_only:
        report = train_model(args.generated.resolve(), (args.generated / "output").resolve())
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
