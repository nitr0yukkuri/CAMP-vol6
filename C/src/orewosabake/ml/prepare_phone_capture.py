#!/usr/bin/env python3
"""Prepare reviewed phone-capture CSV/JPEG labels as grouped COCO data.

AI proposals are never imported as ground truth. Only reviewed rows with human
head/tail states and manually drawn boxes for visible parts are eligible.
Fish and sessions are joined into connected holdout groups so neither can
leak across train, validation, and test.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[1]
GENERATED_ROOT = PROJECT_ROOT / "ml" / "generated"
SPLITS = {"train", "validation", "test"}
PARTS = {"head": 1, "tail": 2}
VISIBLE_STATES = {"present_visible", "removed_confirmed"}


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        if self.parent[item] != item:
            self.parent[item] = self.find(self.parent[item])
        return self.parent[item]

    def union(self, left: str, right: str) -> None:
        root_left, root_right = self.find(left), self.find(right)
        if root_left != root_right:
            self.parent[max(root_left, root_right)] = min(root_left, root_right)


def group_rows(rows: list[dict[str, str]]) -> dict[str, str]:
    """Return a stable group ID per CSV row, joining shared fish or sessions."""
    union = UnionFind()
    row_keys: list[tuple[str, str]] = []
    for row_number, row in enumerate(rows, 2):
        fish_id = row.get("fish_id", "").strip()
        session_id = row.get("session_id", "").strip()
        if not fish_id or not session_id:
            raise ValueError(f"CSV row {row_number}: fish_id and session_id are required")
        fish_key, session_key = f"fish:{fish_id}", f"session:{session_id}"
        union.union(fish_key, session_key)
        row_keys.append((fish_key, session_key))

    components: dict[str, set[str]] = defaultdict(set)
    row_roots: list[str] = []
    for fish_key, session_key in row_keys:
        root = union.find(fish_key)
        row_roots.append(root)
        components[root].update((fish_key, session_key))

    ids: dict[str, str] = {}
    for root, members in components.items():
        canonical = "\n".join(sorted(members)).encode("utf-8")
        ids[root] = f"group-{hashlib.sha256(canonical).hexdigest()[:12]}"
    return {str(index): ids[root] for index, root in enumerate(row_roots)}


def make_split_template(rows: list[dict[str, str]], output_root: Path) -> Path:
    row_groups = group_rows(rows)
    members: dict[str, dict[str, set[str]]] = defaultdict(lambda: {"fish": set(), "session": set()})
    for index, row in enumerate(rows):
        group_id = row_groups[str(index)]
        members[group_id]["fish"].add(row["fish_id"].strip())
        members[group_id]["session"].add(row["session_id"].strip())
    output_root.mkdir(parents=True, exist_ok=True)
    template = output_root / "group-split-template.csv"
    with template.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["group_id", "fish_ids", "session_ids", "split"])
        writer.writeheader()
        for group_id in sorted(members):
            writer.writerow({
                "group_id": group_id,
                "fish_ids": ";".join(sorted(members[group_id]["fish"])),
                "session_ids": ";".join(sorted(members[group_id]["session"])),
                "split": "",
            })
    return template


def read_split_map(path: Path) -> dict[str, str]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not {"group_id", "split"}.issubset(reader.fieldnames):
            raise ValueError("split map requires group_id and split columns")
        result: dict[str, str] = {}
        for row_number, row in enumerate(reader, 2):
            group_id = (row.get("group_id") or "").strip()
            split = (row.get("split") or "").strip().lower()
            if not group_id:
                continue
            if split not in SPLITS:
                raise ValueError(f"Split map row {row_number}: split must be train, validation, or test")
            if group_id in result and result[group_id] != split:
                raise ValueError(f"Split map assigns {group_id} to multiple splits")
            result[group_id] = split
    return result


def normalized_box(row: dict[str, str], part: str, row_number: int) -> list[float] | None:
    state = row.get(f"{part}_status", "").strip()
    source = row.get(f"{part}_status_source", "").strip()
    box_source = row.get(f"{part}_bbox_source", "").strip()
    names = [f"{part}_bbox_{suffix}" for suffix in ("x", "y", "width", "height")]
    values = [row.get(name, "").strip() for name in names]
    has_values = any(values)

    if row.get("review_status", "").strip() != "reviewed" or source != "manual":
        raise ValueError(f"CSV row {row_number}: {part} state has not been human reviewed")
    if state not in VISIBLE_STATES:
        raise ValueError(f"CSV row {row_number}: {part} state is ambiguous ({state or 'blank'})")
    if state == "removed_confirmed":
        if has_values or box_source == "manual":
            raise ValueError(f"CSV row {row_number}: removed {part} must not have a box")
        return None
    if box_source != "manual" or not all(values):
        raise ValueError(f"CSV row {row_number}: visible {part} needs a manually drawn box")
    try:
        x, y, width, height = map(float, values)
    except ValueError as error:
        raise ValueError(f"CSV row {row_number}: {part} box contains a non-number") from error
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < width <= 1 and 0 < height <= 1 and x + width <= 1.000001 and y + height <= 1.000001):
        raise ValueError(f"CSV row {row_number}: {part} box must be normalized and inside the image")
    return [x, y, width, height]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="capture-manifest.csv")
    parser.add_argument("--images-dir", type=Path, required=True, help="folder containing the captured JPEG files")
    parser.add_argument("--output", type=Path, default=GENERATED_ROOT / "phone-capture")
    parser.add_argument("--write-split-template", action="store_true", help="write a blank grouped split CSV and stop")
    parser.add_argument("--split-map", type=Path, help="completed group-split-template.csv with all 3 split names")
    parser.add_argument("--force", action="store_true", help="replace only the selected output folder or split template")
    args = parser.parse_args()

    output_root = args.output.resolve()
    allowed_output_root = (GENERATED_ROOT / "phone-capture").resolve()
    try:
        output_root.relative_to(allowed_output_root)
    except ValueError:
        parser.error(f"--output must stay under {allowed_output_root}")

    with args.manifest.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"session_id", "fish_id", "frame_path", "review_status", "head_status", "head_status_source", "tail_status", "tail_status_source"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            parser.error(f"manifest is missing required columns: {', '.join(sorted(required - set(reader.fieldnames or [])))}")
        rows = list(reader)
    if not rows:
        parser.error("manifest contains no image rows")

    row_groups = group_rows(rows)
    group_ids = set(row_groups.values())
    if args.write_split_template:
        template_path = output_root / "group-split-template.csv"
        if template_path.exists() and not args.force:
            parser.error(f"{template_path} already exists; pass --force to replace only this split template")
        if template_path.exists():
            template_path.unlink()
        template = make_split_template(rows, output_root)
        print(f"Wrote {template} for {len(group_ids)} independent fish/session groups.")
        if len(group_ids) < 3:
            print("At least three independent groups are required for train, validation, and test; this pilot cannot yet support a held-out evaluation.")
        return 0
    if not args.split_map:
        parser.error("pass --write-split-template first, then fill its split column and pass --split-map")

    split_map = read_split_map(args.split_map)
    missing = group_ids - split_map.keys()
    extra = split_map.keys() - group_ids
    if missing or extra:
        parser.error(f"split map must cover the manifest's exact groups (missing={len(missing)}, extra={len(extra)})")
    if set(split_map.values()) != SPLITS:
        parser.error("split map must include at least one independent group for train, validation, and test")

    if output_root.exists():
        if not args.force:
            parser.error(f"{output_root} already exists; pass --force to replace this generated output")
        shutil.rmtree(output_root)

    images_root = args.images_dir.resolve()
    prepared: dict[str, list[dict[str, Any]]] = {split: [] for split in SPLITS}
    excluded: Counter[str] = Counter()
    seen_paths: set[Path] = set()
    for index, row in enumerate(rows):
        row_number = index + 2
        group_id = row_groups[str(index)]
        split = split_map[group_id]
        raw_path = row.get("frame_path", "").strip()
        if not raw_path:
            excluded["missing_frame_path"] += 1
            continue
        image_path = (images_root / raw_path).resolve()
        try:
            image_path.relative_to(images_root)
        except ValueError:
            excluded["path_outside_images_dir"] += 1
            continue
        if image_path in seen_paths:
            excluded["duplicate_frame_path"] += 1
            continue
        seen_paths.add(image_path)
        if not image_path.is_file():
            excluded["missing_image_file"] += 1
            continue

        try:
            boxes = {part: normalized_box(row, part, row_number) for part in PARTS}
        except ValueError as error:
            excluded[str(error).split(": ", 1)[-1].split(" (")[0]] += 1
            continue
        if not any(boxes.values()):
            excluded["no_visible_head_or_tail_box"] += 1
            continue
        try:
            with Image.open(image_path) as image:
                width, height = image.size
                image.verify()
        except Exception:
            excluded["unreadable_image"] += 1
            continue
        prepared[split].append({
            "path": image_path,
            "name": f"{split}_{len(prepared[split]) + 1:05d}_{image_path.name}",
            "width": width,
            "height": height,
            "boxes": boxes,
            "group_id": group_id,
        })

    empty_splits = [split for split, images in prepared.items() if not images]
    if empty_splits:
        parser.error(f"no eligible reviewed images in split(s): {', '.join(sorted(empty_splits))}")
    for split, images in prepared.items():
        counts = Counter(part for image in images for part, box in image["boxes"].items() if box)
        missing_classes = set(PARTS) - counts.keys()
        if missing_classes:
            parser.error(f"{split} lacks manually reviewed positive boxes for: {', '.join(sorted(missing_classes))}")

    output_root.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {
        "format": "COCO",
        "split_method": "connected_components_of_shared_fish_id_or_session_id",
        "group_count": len(group_ids),
        "excluded_rows": dict(sorted(excluded.items())),
        "splits": {},
    }
    categories = [{"id": 1, "name": "head"}, {"id": 2, "name": "tail"}]
    for split in sorted(SPLITS):
        split_root = output_root / "coco" / split
        images_dir = split_root / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        coco_images: list[dict[str, Any]] = []
        annotations: list[dict[str, Any]] = []
        class_counts: Counter[str] = Counter()
        for image_id, item in enumerate(prepared[split], 1):
            shutil.copy2(item["path"], images_dir / item["name"])
            coco_images.append({"id": image_id, "file_name": item["name"], "width": item["width"], "height": item["height"]})
            for part, category_id in PARTS.items():
                box = item["boxes"][part]
                if not box:
                    continue
                x, y, box_width, box_height = box
                pixel_box = [x * item["width"], y * item["height"], box_width * item["width"], box_height * item["height"]]
                annotations.append({
                    "id": len(annotations) + 1,
                    "image_id": image_id,
                    "category_id": category_id,
                    "bbox": pixel_box,
                    "area": pixel_box[2] * pixel_box[3],
                    "iscrowd": 0,
                })
                class_counts[part] += 1
        payload = {
            "info": {"description": "Human-reviewed phone capture head/tail boxes"},
            "licenses": [],
            "images": coco_images,
            "annotations": annotations,
            "categories": categories,
        }
        (split_root / "labels.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        summary["splits"][split] = {"images": len(coco_images), "annotations": len(annotations), "class_counts": dict(sorted(class_counts.items()))}

    summary_path = output_root / "phone-capture-summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Prepared grouped COCO data under {output_root}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
