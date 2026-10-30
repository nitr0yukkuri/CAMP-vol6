#!/usr/bin/env python3
"""Train and evaluate a small head-vs-tail crop classifier from the COCO split.

This is a CPU-friendly image-learning fallback, not a full-frame detector. It
learns from annotated crops and must not be presented as MediaPipe/YOLO output.
Only Python, NumPy, and Pillow are required.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import platform
import sys
from pathlib import Path
from typing import Any

import numpy as np
import PIL
from PIL import Image, ImageDraw, ImageOps


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = PROJECT_ROOT / "ml" / "generated" / "coco"
DEFAULT_OUTPUT = PROJECT_ROOT / "ml" / "generated" / "head-tail-hog"
LABELS = {1: "head", 2: "tail"}
CLASS_TO_INDEX = {"head": 0, "tail": 1}


def letterboxed_crop(image: Image.Image, box: list[float], size: int, padding: float) -> Image.Image:
    x, y, width, height = box
    pad_x, pad_y = width * padding, height * padding
    left = max(0, math.floor(x - pad_x))
    top = max(0, math.floor(y - pad_y))
    right = min(image.width, math.ceil(x + width + pad_x))
    bottom = min(image.height, math.ceil(y + height + pad_y))
    if right <= left or bottom <= top:
        raise ValueError(f"Invalid crop box: {box}")

    crop = image.crop((left, top, right, bottom)).convert("L")
    crop.thumbnail((size, size), Image.Resampling.BILINEAR)
    canvas = Image.new("L", (size, size), color=114)
    canvas.paste(crop, ((size - crop.width) // 2, (size - crop.height) // 2))
    return canvas


def hog_descriptor(image: Image.Image, cell_size: int = 8, bins: int = 9) -> np.ndarray:
    gray = np.asarray(image, dtype=np.float32) / 255.0
    grad_y, grad_x = np.gradient(gray)
    magnitude = np.hypot(grad_x, grad_y)
    angle = np.mod(np.degrees(np.arctan2(grad_y, grad_x)), 180.0)

    height, width = gray.shape
    cells_y, cells_x = height // cell_size, width // cell_size
    rows, cols = np.indices((height, width))
    cell_ids = (rows // cell_size) * cells_x + (cols // cell_size)

    floating_bin = angle * (bins / 180.0)
    low_bin = np.floor(floating_bin).astype(np.int32) % bins
    high_bin = (low_bin + 1) % bins
    upper_weight = floating_bin - np.floor(floating_bin)
    flat_cells = cell_ids.reshape(-1)
    hist_size = cells_y * cells_x * bins
    hist = np.bincount(
        flat_cells * bins + low_bin.reshape(-1),
        weights=(magnitude * (1.0 - upper_weight)).reshape(-1),
        minlength=hist_size,
    )
    hist += np.bincount(
        flat_cells * bins + high_bin.reshape(-1),
        weights=(magnitude * upper_weight).reshape(-1),
        minlength=hist_size,
    )
    cell_hist = hist.reshape(cells_y, cells_x, bins).astype(np.float32)

    blocks = []
    for row in range(cells_y - 1):
        for col in range(cells_x - 1):
            block = cell_hist[row : row + 2, col : col + 2].reshape(-1)
            block = block / (np.linalg.norm(block) + 1e-6)
            block = np.minimum(block, 0.2)
            block = block / (np.linalg.norm(block) + 1e-6)
            blocks.append(block)
    descriptor = np.concatenate(blocks).astype(np.float32)
    return descriptor / (np.linalg.norm(descriptor) + 1e-6)


def load_split(dataset_root: Path, split: str, image_size: int, padding: float, augment_flip: bool) -> tuple[np.ndarray, np.ndarray, list[dict[str, str]]]:
    split_root = dataset_root / split
    payload = json.loads((split_root / "labels.json").read_text(encoding="utf-8"))
    images = {record["id"]: record for record in payload["images"]}
    annotations_by_image: dict[int, list[dict[str, Any]]] = {}
    for annotation in payload["annotations"]:
        annotations_by_image.setdefault(annotation["image_id"], []).append(annotation)

    features: list[np.ndarray] = []
    targets: list[int] = []
    records: list[dict[str, Any]] = []

    for image_id, annotations in annotations_by_image.items():
        image_record = images[image_id]
        image_name = image_record["file_name"]
        image_path = split_root / "data" / image_name
        with Image.open(image_path) as image:
            for annotation in annotations:
                category_id = int(annotation["category_id"])
                if category_id not in LABELS:
                    raise ValueError(f"Unknown category id {category_id} in {split_root / 'labels.json'}")
                label = LABELS[category_id]
                bbox = [float(value) for value in annotation["bbox"]]
                crop = letterboxed_crop(image, bbox, image_size, padding)
                features.append(hog_descriptor(crop))
                targets.append(CLASS_TO_INDEX[label])
                records.append({
                    "split": split,
                    "image": image_name,
                    "label": label,
                    "annotation_id": str(annotation["id"]),
                    "bbox": bbox,
                })

                if augment_flip:
                    features.append(hog_descriptor(ImageOps.mirror(crop)))
                    targets.append(CLASS_TO_INDEX[label])
                    records.append({
                        "split": split,
                        "image": image_name,
                        "label": label,
                        "annotation_id": str(annotation["id"]),
                        "bbox": bbox,
                        "augmentation": "horizontal_flip",
                    })

    if not features:
        raise ValueError(f"No labeled crops found in {split_root}")
    return np.stack(features), np.asarray(targets, dtype=np.int64), records


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def train_logistic_regression(
    train_x: np.ndarray,
    train_y: np.ndarray,
    validation_x: np.ndarray,
    validation_y: np.ndarray,
    epochs: int,
    seed: int,
    learning_rate: float = 0.02,
    l2: float = 0.01,
    patience: int = 15,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, float]]]:
    rng = np.random.default_rng(seed)
    weights = np.zeros((train_x.shape[1], 2), dtype=np.float32)
    bias = np.zeros(2, dtype=np.float32)
    first_moment_w = np.zeros_like(weights)
    second_moment_w = np.zeros_like(weights)
    first_moment_b = np.zeros_like(bias)
    second_moment_b = np.zeros_like(bias)
    beta1, beta2, epsilon = 0.9, 0.999, 1e-8
    step = 0

    best_loss = float("inf")
    best_weights = weights.copy()
    best_bias = bias.copy()
    stale_epochs = 0
    history: list[dict[str, float]] = []
    batch_size = 64

    for epoch in range(epochs):
        order = rng.permutation(len(train_y))
        for start in range(0, len(order), batch_size):
            batch_indices = order[start : start + batch_size]
            batch_x, batch_y = train_x[batch_indices], train_y[batch_indices]
            probabilities = softmax(batch_x @ weights + bias)
            probabilities[np.arange(len(batch_y)), batch_y] -= 1.0
            grad_w = (batch_x.T @ probabilities) / len(batch_y) + l2 * weights
            grad_b = probabilities.mean(axis=0)

            step += 1
            first_moment_w = beta1 * first_moment_w + (1.0 - beta1) * grad_w
            second_moment_w = beta2 * second_moment_w + (1.0 - beta2) * np.square(grad_w)
            first_moment_b = beta1 * first_moment_b + (1.0 - beta1) * grad_b
            second_moment_b = beta2 * second_moment_b + (1.0 - beta2) * np.square(grad_b)
            corrected_m_w = first_moment_w / (1.0 - beta1**step)
            corrected_v_w = second_moment_w / (1.0 - beta2**step)
            corrected_m_b = first_moment_b / (1.0 - beta1**step)
            corrected_v_b = second_moment_b / (1.0 - beta2**step)
            weights -= learning_rate * corrected_m_w / (np.sqrt(corrected_v_w) + epsilon)
            bias -= learning_rate * corrected_m_b / (np.sqrt(corrected_v_b) + epsilon)

        validation_probabilities = softmax(validation_x @ weights + bias)
        validation_loss = float(-np.log(np.maximum(validation_probabilities[np.arange(len(validation_y)), validation_y], 1e-8)).mean())
        validation_predictions = validation_probabilities.argmax(axis=1)
        validation_accuracy = float((validation_predictions == validation_y).mean())
        history.append({"epoch": float(epoch + 1), "validation_loss": validation_loss, "validation_accuracy": validation_accuracy})

        if validation_loss < best_loss - 1e-5:
            best_loss = validation_loss
            best_weights = weights.copy()
            best_bias = bias.copy()
            stale_epochs = 0
        else:
            stale_epochs += 1
            if stale_epochs >= patience:
                break

    return best_weights, best_bias, history


def classification_metrics(y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    predictions = probabilities.argmax(axis=1)
    matrix = np.zeros((2, 2), dtype=np.int64)
    for actual, predicted in zip(y_true, predictions):
        matrix[int(actual), int(predicted)] += 1

    per_class = {}
    recalls = []
    f1_values = []
    for index, name in enumerate(("head", "tail")):
        tp = int(matrix[index, index])
        fn = int(matrix[index].sum() - tp)
        fp = int(matrix[:, index].sum() - tp)
        support = int(matrix[index].sum())
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_class[name] = {"precision": precision, "recall": recall, "f1": f1, "support": support}
        recalls.append(recall)
        f1_values.append(f1)

    return {
        "samples": int(len(y_true)),
        "accuracy": float((predictions == y_true).mean()),
        "balanced_accuracy": float(np.mean(recalls)),
        "macro_f1": float(np.mean(f1_values)),
        "confusion_matrix_rows_actual_cols_predicted": matrix.tolist(),
        "classes": per_class,
    }


def image_wise_metrics(records: list[dict[str, Any]], y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    predictions = probabilities.argmax(axis=1)
    grouped: dict[str, list[int]] = {}
    for index, record in enumerate(records):
        grouped.setdefault(record["image"], []).append(index)

    per_image = []
    for image_name, indexes in grouped.items():
        correct = sum(int(predictions[index] == y_true[index]) for index in indexes)
        per_image.append({
            "image": image_name,
            "crops": len(indexes),
            "correct": correct,
            "accuracy": correct / len(indexes),
        })
    per_image.sort(key=lambda row: (row["accuracy"], -row["crops"], row["image"]))
    accuracies = [row["accuracy"] for row in per_image]
    return {
        "images": len(per_image),
        "mean_per_image_accuracy": float(np.mean(accuracies)),
        "median_per_image_accuracy": float(np.median(accuracies)),
        "images_below_60_percent": sum(value < 0.6 for value in accuracies),
        "hardest_images": per_image[:5],
    }


def save_error_montage(
    dataset_root: Path,
    output_path: Path,
    records: list[dict[str, Any]],
    y_true: np.ndarray,
    probabilities: np.ndarray,
    image_size: int,
    padding: float,
) -> None:
    ranked_errors = [
        (float(probabilities[index].max()), index)
        for index in range(len(y_true))
        if int(probabilities[index].argmax()) != int(y_true[index])
    ]
    ranked_errors.sort(reverse=True)
    selected = ranked_errors[:12]
    columns, cell_width, cell_height = 3, 270, 270
    rows = max(1, math.ceil(len(selected) / columns))
    sheet = Image.new("RGB", (columns * cell_width, rows * cell_height + 48), "#f1f4f5")
    draw = ImageDraw.Draw(sheet)
    draw.text((14, 14), "Misclassified test crops · GT box + 15% context", fill="#17363d")

    for rank, (confidence, index) in enumerate(selected):
        record = records[index]
        image_path = dataset_root / "test" / "data" / record["image"]
        with Image.open(image_path) as source:
            crop = letterboxed_crop(source.convert("RGB"), record["bbox"], image_size, padding).convert("RGB")
        tile_size = 220
        tile = crop.resize((tile_size, tile_size), Image.Resampling.BICUBIC)
        column, row = rank % columns, rank // columns
        left, top = column * cell_width + 14, row * cell_height + 42
        sheet.paste(tile, (left, top))
        actual = ("head", "tail")[int(y_true[index])]
        predicted = ("head", "tail")[int(probabilities[index].argmax())]
        draw.text((left, top + tile_size + 4), f"actual {actual} / predicted {predicted} ({confidence:.2f})", fill="#17363d")
        draw.text((left, top + tile_size + 18), record["image"][-25:], fill="#425b60")

    sheet.save(output_path, quality=90)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--image-size", type=int, default=64)
    parser.add_argument("--padding", type=float, default=0.15)
    parser.add_argument("--epochs", type=int, default=120)
    parser.add_argument("--patience", type=int, default=18)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if args.image_size < 32 or args.image_size % 8:
        raise ValueError("--image-size must be at least 32 and divisible by 8")
    args.output.mkdir(parents=True, exist_ok=True)

    train_x, train_y, train_records = load_split(args.dataset, "train", args.image_size, args.padding, augment_flip=True)
    validation_x, validation_y, validation_records = load_split(args.dataset, "validation", args.image_size, args.padding, augment_flip=False)
    test_x, test_y, test_records = load_split(args.dataset, "test", args.image_size, args.padding, augment_flip=False)

    weights, bias, history = train_logistic_regression(
        train_x, train_y, validation_x, validation_y, args.epochs, args.seed, patience=args.patience
    )
    validation_probabilities = softmax(validation_x @ weights + bias)
    test_probabilities = softmax(test_x @ weights + bias)

    model_path = args.output / "head-tail-hog.npz"
    np.savez_compressed(model_path, weights=weights, bias=bias, image_size=np.asarray(args.image_size))
    with (args.output / "test-predictions.csv").open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=["image", "annotation_id", "x", "y", "width", "height", "actual", "predicted", "head_probability", "tail_probability", "correct"])
        writer.writeheader()
        for record, actual, probabilities in zip(test_records, test_y, test_probabilities):
            predicted = int(probabilities.argmax())
            x, y, width, height = record["bbox"]
            writer.writerow({
                "image": record["image"],
                "annotation_id": record["annotation_id"],
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "actual": ("head", "tail")[int(actual)],
                "predicted": ("head", "tail")[predicted],
                "head_probability": f"{probabilities[0]:.6f}",
                "tail_probability": f"{probabilities[1]:.6f}",
                "correct": predicted == int(actual),
            })

    montage_path = args.output / "error-montage.jpg"
    save_error_montage(args.dataset, montage_path, test_records, test_y, test_probabilities, args.image_size, args.padding)

    source_train_records = [record for record in train_records if "augmentation" not in record]
    best_epoch = min(history, key=lambda row: row["validation_loss"])
    train_class_counts = {
        "head": sum(record["label"] == "head" for record in source_train_records),
        "tail": sum(record["label"] == "tail" for record in source_train_records),
    }
    majority_class = 0 if train_class_counts["head"] >= train_class_counts["tail"] else 1

    report = {
        "experiment": "HOG + L2-regularized logistic regression on annotated fish-part crops",
        "task": "classify a supplied crop as head or tail; this is not object detection",
        "features": {"type": "HOG", "image_size": args.image_size, "cell_size": 8, "orientation_bins": 9, "padding_ratio": args.padding},
        "runtime": {"python": platform.python_version(), "numpy": np.__version__, "pillow": PIL.__version__, "device": "CPU"},
        "training": {
            "original_crops": len(source_train_records),
            "original_class_counts": train_class_counts,
            "crop_samples_with_horizontal_flip": int(len(train_y)),
            "epochs_ran": len(history),
            "best_epoch_by_validation_loss": int(best_epoch["epoch"]),
            "best_validation_loss": best_epoch["validation_loss"],
        },
        "validation": classification_metrics(validation_y, validation_probabilities),
        "test": classification_metrics(test_y, test_probabilities),
        "test_baseline": {
            "type": "always predict the training majority class",
            "class": ("head", "tail")[majority_class],
            "accuracy": float((test_y == majority_class).mean()),
            "balanced_accuracy": 0.5,
        },
        "test_unique_images": len({record["image"] for record in test_records}),
        "test_image_wise": image_wise_metrics(test_records, test_y, test_probabilities),
        "model_path": str(model_path),
        "test_error_montage": str(montage_path),
        "split_method": "capture-day grouped COCO split from train_detector.py",
        "limitations": [
            "Evaluates already-cropped annotated parts, not localization in a full image or video.",
            "Small validation and test sets make metrics noisy.",
            "The public images do not represent smartphone fish-preparation scenes.",
            "This model is not compatible with MediaPipe Tasks ObjectDetector.",
        ],
    }
    (args.output / "metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output / "training-history.json").write_text(json.dumps(history, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
