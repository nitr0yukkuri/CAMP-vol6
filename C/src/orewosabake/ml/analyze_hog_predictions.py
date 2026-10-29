#!/usr/bin/env python3
"""Create a full-frame visual audit of the held-out HOG crop predictions."""

from __future__ import annotations

import csv
import json
import math
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATASET_ROOT = PROJECT_ROOT / "ml" / "generated" / "coco"
RESULT_ROOT = PROJECT_ROOT / "ml" / "generated" / "head-tail-hog"
PREDICTIONS = RESULT_ROOT / "test-predictions.csv"
OUTPUT = RESULT_ROOT / "full-frame-test-audit.jpg"
STRATIFIED_OUTPUT = RESULT_ROOT / "stratified-analysis.json"


def summarize(rows: list[dict[str, str]], image_count: int) -> dict[str, object]:
    correct = sum(row["correct"].lower() == "true" for row in rows)
    class_recall = {}
    for label in ("head", "tail"):
        class_rows = [row for row in rows if row["actual"] == label]
        class_recall[label] = sum(row["predicted"] == label for row in class_rows) / len(class_rows) if class_rows else None
    return {
        "images": image_count,
        "crops": len(rows),
        "accuracy": correct / len(rows) if rows else None,
        "recall_by_class": class_recall,
    }


def main() -> None:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    with PREDICTIONS.open(encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            grouped[row["image"]].append(row)

    columns, tile_width, tile_height = 4, 300, 250
    rows = math.ceil(len(grouped) / columns)
    sheet = Image.new("RGB", (columns * tile_width, rows * tile_height + 46), "#f2f4f3")
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 14), "Held-out test images · green = crop label correct · red = crop label wrong", fill="#17363d")

    for index, (image_name, predictions) in enumerate(sorted(grouped.items())):
        image_path = DATASET_ROOT / "test" / "data" / image_name
        with Image.open(image_path) as opened:
            source = opened.convert("RGB")
            original_width, original_height = source.size
            source.thumbnail((tile_width - 24, tile_height - 44), Image.Resampling.BICUBIC)

        column, row = index % columns, index // columns
        left, top = column * tile_width + 12, row * tile_height + 34
        sheet.paste(source, (left, top))
        scale_x, scale_y = source.width / original_width, source.height / original_height

        for prediction in predictions:
            x, y = float(prediction["x"]), float(prediction["y"])
            width, height = float(prediction["width"]), float(prediction["height"])
            x0, y0 = left + round(x * scale_x), top + round(y * scale_y)
            x1, y1 = left + round((x + width) * scale_x), top + round((y + height) * scale_y)
            correct = prediction["correct"].lower() == "true"
            color = "#07866e" if correct else "#c63d43"
            draw.rectangle((x0, y0, x1, y1), outline=color, width=2)
            label = f"{prediction['actual'][0].upper()}>{prediction['predicted'][0].upper()}"
            draw.text((x0, max(top, y0 - 12)), label, fill=color)

        draw.text((left, top + source.height + 5), f"{image_name} · {len(predictions)} crops", fill="#17363d")

    sheet.save(OUTPUT, quality=91)
    by_archive_folder: dict[str, list[dict[str, str]]] = defaultdict(list)
    by_box_count: dict[str, list[dict[str, str]]] = defaultdict(list)
    for image_name, predictions in grouped.items():
        archive_folder = image_name.split("_", 1)[0]
        by_archive_folder[archive_folder].extend(predictions)
        count = len(predictions)
        bucket = "2-4" if count <= 4 else "5-8" if count <= 8 else "9+"
        by_box_count[bucket].extend(predictions)

    stratified = {
        "warning": "Subgroups are small and all images share one held-out capture day; descriptive only.",
        "by_original_archive_folder": {
            name: summarize(rows, len({row["image"] for row in rows}))
            for name, rows in sorted(by_archive_folder.items())
        },
        "by_annotation_count_per_image": {
            name: summarize(rows, sum(1 for items in grouped.values() if ("2-4" if len(items) <= 4 else "5-8" if len(items) <= 8 else "9+") == name))
            for name, rows in sorted(by_box_count.items())
        },
    }
    STRATIFIED_OUTPUT.write_text(json.dumps(stratified, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(grouped)} images)")
    print(json.dumps(stratified, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
