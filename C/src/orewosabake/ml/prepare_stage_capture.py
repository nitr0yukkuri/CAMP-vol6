"""Prepare reviewed phone frames as fish-specific MediaPipe image-classifier data."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
GENERATED_ROOT = PROJECT_ROOT / "ml" / "generated" / "fish-stage"
SPLITS = {"train", "validation", "test"}
FISH_NAMES = {
    "hamachi": {"ハマチ", "はまち", "ブリ", "ぶり"},
    "aji": {"アジ", "あじ"},
    "saba": {"サバ", "さば"},
    "tai": {"タイ", "たい", "鯛"},
}
STAGE_LABELS = {"whole", "head_removed", "gutted", "filleting", "finished"}
REJECT_LABEL = "unknown"
OTHER_STAGE_VALUES = {"other", "その他", "判定対象外", "判定対象外（工程外）", "判定対象外（工程外の画像）"}
UNKNOWN_STAGE_VALUES = {"unknown", "不明", "未確認", "未確認（不明）", "不明・未確認（学習対象外）"}
MODEL_LABELS = STAGE_LABELS | {REJECT_LABEL}
STAGE_ALIASES = {"未処理": "whole", "頭を外した": "head_removed", "内臓処理済み": "gutted"}


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        if self.parent[item] != item:
            self.parent[item] = self.find(self.parent[item])
        return self.parent[item]

    def union(self, left: str, right: str) -> None:
        left_root, right_root = self.find(left), self.find(right)
        if left_root != right_root:
            self.parent[max(left_root, right_root)] = min(left_root, right_root)


def group_rows(rows: list[dict[str, str]]) -> dict[int, str]:
    union = UnionFind()
    keys: list[tuple[str, str]] = []
    for row_number, row in enumerate(rows, 2):
        fish_id = row.get("fish_id", "").strip()
        session_id = row.get("session_id", "").strip()
        if not fish_id or not session_id:
            raise ValueError(f"CSV row {row_number}: fish_id and session_id are required")
        fish_key, session_key = f"fish:{fish_id}", f"session:{session_id}"
        union.union(fish_key, session_key)
        keys.append((fish_key, session_key))

    component_members: dict[str, set[str]] = defaultdict(set)
    roots: list[str] = []
    for fish_key, session_key in keys:
        root = union.find(fish_key)
        roots.append(root)
        component_members[root].update((fish_key, session_key))
    group_ids = {
        root: "group-" + hashlib.sha256("\n".join(sorted(members)).encode("utf-8")).hexdigest()[:12]
        for root, members in component_members.items()
    }
    return {index: group_ids[root] for index, root in enumerate(roots)}


def make_split_template(rows: list[dict[str, str]], output_root: Path) -> Path:
    row_groups = group_rows(rows)
    members: dict[str, dict[str, set[str]]] = defaultdict(lambda: {"fish": set(), "session": set()})
    for index, row in enumerate(rows):
        group_id = row_groups[index]
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
                raise ValueError(f"split map row {row_number}: split must be train, validation, or test")
            if group_id in result and result[group_id] != split:
                raise ValueError(f"split map assigns {group_id} to multiple splits")
            result[group_id] = split
    return result


def paths_overlap(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_rgba_png(path: Path) -> bool:
    with path.open("rb") as handle:
        header = handle.read(26)
    return len(header) >= 26 and header[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">I", header[8:12])[0] == 13 and header[25] == 6


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="capture-manifest.csv exported by the app")
    parser.add_argument("--images-dir", type=Path, required=True, help="folder containing the captured JPEG, PNG, and WebP files")
    parser.add_argument("--fish-id", choices=sorted(FISH_NAMES), required=True, help="one guide species; models do not transfer between fish")
    parser.add_argument("--output", type=Path, default=None, help="generated dataset folder (defaults under ml/generated/fish-stage)")
    parser.add_argument("--write-split-template", action="store_true", help="write a fish/session grouped split template and stop")
    parser.add_argument("--split-map", type=Path, help="completed group-split-template.csv")
    parser.add_argument("--force", action="store_true", help="replace only this fish's generated output folder")
    args = parser.parse_args()

    output_root = (args.output or GENERATED_ROOT / args.fish_id / "dataset").resolve()
    generated_root = GENERATED_ROOT.resolve()
    try:
        output_root.relative_to(generated_root)
    except ValueError:
        parser.error(f"--output must stay under {generated_root}")
    if output_root == generated_root:
        parser.error("--output must be a fish-specific subfolder, not the entire generated root")

    images_root = args.images_dir.resolve()
    manifest_path = args.manifest.resolve()
    if paths_overlap(output_root, images_root) or paths_overlap(output_root, manifest_path):
        parser.error("--output must not overlap the input images folder or manifest")

    with args.manifest.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"fish_species", "session_id", "fish_id", "frame_id", "relative_time_ms", "frame_path", "confirmed_stage", "review_status"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            parser.error(f"manifest is missing required columns: {', '.join(sorted(required - set(reader.fieldnames or [])))}")
        all_rows = list(reader)

    fish_names = FISH_NAMES[args.fish_id]
    rows = [row for row in all_rows if row.get("fish_species", "").strip() in fish_names]
    if not rows:
        parser.error(f"manifest contains no rows for {args.fish_id}; expected species labels: {', '.join(sorted(fish_names))}")

    row_groups = group_rows(rows)
    groups = set(row_groups.values())
    if args.write_split_template:
        template_path = output_root.parent / "split-plan" / "group-split-template.csv"
        if template_path.exists() and not args.force:
            parser.error(f"{template_path} already exists; pass --force to replace only this split template")
        template_path.parent.mkdir(parents=True, exist_ok=True)
        template = make_split_template(rows, template_path.parent)
        print(f"Wrote {template} for {len(groups)} independent fish/session groups.")
        if len(groups) < 3:
            print("At least three independent fish/session groups are required for train, validation, and test.")
        return 0

    if not args.split_map:
        parser.error("pass --write-split-template first, assign whole fish/session groups, then pass --split-map")

    split_map = read_split_map(args.split_map)
    if groups - split_map.keys() or split_map.keys() - groups:
        parser.error(f"split map must cover the selected fish's exact groups (missing={len(groups - split_map.keys())}, extra={len(split_map.keys() - groups)})")
    if set(split_map.values()) != SPLITS:
        parser.error("split map must include independent groups for train, validation, and test")

    eligible: list[tuple[str, str, Path, str, str, int, str, Path | None, bool]] = []
    excluded: Counter[str] = Counter()
    seen: dict[Path, tuple[int, str]] = {}
    seen_image_hashes: dict[str, tuple[int, str]] = {}
    for row_number, row in enumerate(rows, 2):
        if row.get("image_class", "fish").strip().lower() == "non_fish":
            excluded["non_fish_image"] += 1
            continue
        if row.get("review_status", "").strip() != "reviewed":
            excluded["stage_label_not_reviewed"] += 1
            continue
        raw_stage = row.get("confirmed_stage", "").strip()
        normalized_stage = raw_stage.casefold()
        if normalized_stage in UNKNOWN_STAGE_VALUES:
            excluded["stage_label_unknown"] += 1
            continue
        stage = REJECT_LABEL if normalized_stage in OTHER_STAGE_VALUES else STAGE_ALIASES.get(raw_stage, normalized_stage)
        if stage not in MODEL_LABELS:
            excluded["unknown_or_unsupported_stage"] += 1
            continue
        try:
            relative_time_ms = int(row.get("relative_time_ms", "").strip())
        except (TypeError, ValueError):
            excluded["missing_or_invalid_timestamp"] += 1
            continue
        if relative_time_ms < 0:
            excluded["missing_or_invalid_timestamp"] += 1
            continue
        capture_source = row.get("capture_source", "").strip() or "camera_sequence"
        if capture_source not in {"camera_sequence", "static_image"}:
            excluded["invalid_capture_source"] += 1
            continue
        background_mask = row.get("background_mask", "").strip() or "none"
        if background_mask not in {"none", "mediapipe_magic_touch_v1"}:
            excluded["invalid_background_mask"] += 1
            continue
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
        previous_path = seen.get(image_path)
        if previous_path is not None:
            previous_row, previous_stage = previous_path
            if previous_stage != stage:
                parser.error(
                    f"manifest rows {previous_row} and {row_number} reference the same image with conflicting labels "
                    f"({previous_stage} vs {stage})"
                )
            excluded["duplicate_frame_path"] += 1
            continue
        seen[image_path] = (row_number, stage)
        if not image_path.is_file():
            excluded["missing_image_file"] += 1
            continue
        source_image_path: Path | None = None
        raw_source_path = row.get("source_frame_path", "").strip()
        if raw_source_path:
            source_image_path = (images_root / raw_source_path).resolve()
            try:
                source_image_path.relative_to(images_root)
            except ValueError:
                excluded["source_path_outside_images_dir"] += 1
                continue
            if not source_image_path.is_file():
                excluded["missing_source_image_file"] += 1
                continue
        if background_mask == "mediapipe_magic_touch_v1":
            if not source_image_path or image_path.suffix.lower() != ".png" or not is_rgba_png(image_path):
                parser.error(
                    f"CSV row {row_number}: MediaPipe transparent samples require an RGBA PNG frame_path and a valid source_frame_path"
                )
        image_hash = sha256_file(image_path)
        previous_image = seen_image_hashes.get(image_hash)
        if previous_image is not None:
            previous_row, previous_stage = previous_image
            if previous_stage != stage:
                parser.error(
                    f"manifest rows {previous_row} and {row_number} use identical image bytes with conflicting labels "
                    f"({previous_stage} vs {stage})"
                )
            excluded["duplicate_image_content"] += 1
            continue
        seen_image_hashes[image_hash] = (row_number, stage)
        eligible.append((
            split_map[row_groups[row_number - 2]],
            stage,
            image_path,
            row["fish_id"].strip(),
            row["session_id"].strip(),
            relative_time_ms,
            capture_source,
            source_image_path,
            background_mask == "mediapipe_magic_touch_v1",
        ))

    counts: dict[str, Counter[str]] = {split: Counter() for split in SPLITS}
    for split, stage, *_ in eligible:
        counts[split][stage] += 1
    missing = {
        split: sorted(STAGE_LABELS - counts[split].keys())
        for split in SPLITS
        if STAGE_LABELS - counts[split].keys()
    }
    if missing:
        detail = "; ".join(f"{split} missing {', '.join(labels)}" for split, labels in sorted(missing.items()))
        parser.error(f"each split needs reviewed examples for all five states before training: {detail}")

    if any(counts[split][REJECT_LABEL] for split in SPLITS):
        missing_reject = sorted(split for split in SPLITS if not counts[split][REJECT_LABEL])
        if missing_reject:
            parser.error(
                "reviewed 判定対象外 (other) images create an unknown reject class; "
                f"add independent examples to every split (missing: {', '.join(missing_reject)})"
            )

    if output_root.exists():
        if not args.force:
            parser.error(f"{output_root} already exists; pass --force to replace this generated dataset")
        shutil.rmtree(output_root)

    sample_rows: list[dict[str, str]] = []
    mask_counts: Counter[str] = Counter()
    for number, (split, stage, image_path, fish_id, session_id, relative_time_ms, capture_source, source_image_path, is_masked) in enumerate(eligible, 1):
        split_class_dir = output_root / split / stage
        split_class_dir.mkdir(parents=True, exist_ok=True)
        mask_destination: Path | None = None
        if is_masked:
            mask_destination = output_root / "background-mask-sources" / split / stage / f"{number:06d}_{image_path.name}"
            mask_destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(image_path, mask_destination)
            assert source_image_path is not None
            source_destination = output_root / "background-mask-sources" / split / stage / f"{number:06d}_{source_image_path.name}"
            shutil.copy2(source_image_path, source_destination)
            mask_counts[split] += 1

            if split == "train":
                destination = split_class_dir / f"{number:06d}_{image_path.name}"
                shutil.copy2(image_path, destination)
                # Keep the real camera background as a training example as well as the cutout.
                train_source_destination = split_class_dir / f"{number:06d}_{source_image_path.name}"
                shutil.copy2(source_image_path, train_source_destination)
            else:
                # Validation and test must use the unmodified photograph, never its transparent cutout.
                destination = split_class_dir / f"{number:06d}_{source_image_path.name}"
                shutil.copy2(source_image_path, destination)
        else:
            destination = split_class_dir / f"{number:06d}_{image_path.name}"
            shutil.copy2(image_path, destination)
        sample_rows.append({
            "split": split,
            "fish_id": fish_id,
            "session_id": session_id,
            "relative_time_ms": str(relative_time_ms),
            "capture_source": capture_source,
            "stage": stage,
            "image_path": destination.relative_to(output_root).as_posix(),
            "source_frame_path": source_image_path.relative_to(images_root).as_posix() if source_image_path else "",
            "background_mask": "mediapipe_magic_touch_v1" if is_masked else "none",
            "mask_source_image_path": mask_destination.relative_to(output_root).as_posix() if mask_destination else "",
        })

    with (output_root / "stage-samples.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["split", "fish_id", "session_id", "relative_time_ms", "capture_source", "stage", "image_path", "source_frame_path", "background_mask", "mask_source_image_path"])
        writer.writeheader()
        writer.writerows(sample_rows)

    summary = {
        "fish_id": args.fish_id,
        "labels": sorted({label for split in counts.values() for label in split}),
        "reject_class": {
            "label": REJECT_LABEL,
            "source": "reviewed confirmed_stage=other only",
            "warning": "This class learns only from the collected examples; it does not guarantee rejection of every unfamiliar image.",
        },
        "split_method": "connected_groups_of_shared_fish_id_or_session_id",
        "independent_group_count": len(groups),
        "capture_sources": dict(sorted(Counter(item[6] for item in eligible).items())),
        "background_masked_samples_by_split": dict(sorted(mask_counts.items())),
        "masked_image_policy": "Training includes each original plus a transparent cutout; validation and test use only the preserved opaque source photograph. All variants remain in the same fish/session split.",
        "excluded_rows": dict(sorted(excluded.items())),
        "splits": {split: {"images": sum(counts[split].values()), "class_counts": dict(sorted(counts[split].items()))} for split in sorted(SPLITS)},
        "target_per_class": "Google recommends approximately 100 examples per class as an experiment starting point; this is not an accuracy guarantee.",
    }
    output_root.mkdir(parents=True, exist_ok=True)
    (output_root / "stage-dataset-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Prepared reviewed stage-classifier images under {output_root}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
