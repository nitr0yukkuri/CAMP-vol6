# Head/tail crop-classification experiment

- Date: 2026-10-29
- Scope: `C/src/orewosabake` only

## Result in one sentence

A CPU-trained HOG + logistic-regression model classified **pre-cropped** fish-head or fish-tail regions with 75.8% accuracy and 75.4% balanced accuracy on a capture-day-held-out set. This is a useful image-learning baseline, but it is **not an object detector**, not a MediaPipe model, and not evidence of fish-preparation stage recognition.

## Data and split

The source is the local 200-image Mendeley dataset with YOLO `head` / `tail` boxes. Its original training and test folders share capture dates, so the experiment uses the earlier conversion that groups all images from a date into the same split.

| Split | Capture day | Images | Original crops | Head | Tail |
|---|---|---:|---:|---:|---:|
| Train | All other dates | 153 | 1,109 | 619 | 490 |
| Validation | 2019-10-14 | 21 | 42 | 21 | 21 |
| Test | 2019-11-14 | 26 | 157 | 84 | 73 |

The test set contains just **one held-out capture day**. Its 157 annotated crops are correlated: several crops come from the same image and the same fish group. Treat the image count (26) and single-day split as the more important limits, not the raw crop count.

## What was trained

- Crop each ground-truth box with 15% surrounding context; letterbox to 64×64 grayscale.
- Extract HOG features with 8×8-pixel cells, nine orientation bins, and normalized 2×2-cell blocks.
- Fit a two-class L2-regularized logistic regression with Adam. Horizontal flips double the training examples to 2,218.
- Select weights by validation cross-entropy. Best validation loss was at epoch 13; early stopping ended after 31 epochs.
- Runtime: Python 3.12.14, NumPy 2.3.5, Pillow 12.3.0; the experiment used CPU. `nvidia-smi` was unavailable, so NVIDIA GPU availability was not verified.

The classifier receives a crop whose location is already known from the ground-truth annotation. It does not search a full image, output boxes, process video, or distinguish missing parts from occlusion and out-of-frame cases.

## Metrics

| Set | Crops | Accuracy | Balanced accuracy | Macro F1 |
|---|---:|---:|---:|---:|
| Validation | 42 | 88.1% | 88.1% | 88.0% |
| Test | 157 | 75.8% | 75.4% | 75.5% |

Test confusion matrix (rows = actual, columns = predicted):

|  | Predicted head | Predicted tail |
|---|---:|---:|
| Actual head | 68 | 16 |
| Actual tail | 22 | 51 |

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| Head | 75.6% | 81.0% | 78.2% | 84 |
| Tail | 76.1% | 69.9% | 72.9% | 73 |

Always predicting the training majority class (`head`) gets 53.5% test accuracy and 50.0% balanced accuracy. The HOG model is meaningfully above that trivial baseline, but the 12.7-point validation-to-test balanced-accuracy drop suggests the validation result is optimistic or the held-out day differs.

When each test image is weighted equally, mean accuracy is 79.9% and median accuracy is 80.0%; 3 of 26 images are below 60%. This differs from crop-weighted accuracy because images contain different numbers of annotated parts.

Two small descriptive slices help explain that difference:

| Test-image subgroup | Images | Crops | Accuracy | Tail recall |
|---|---:|---:|---:|---:|
| 2–4 annotations per image | 9 | 28 | 85.7% | 71.4% |
| 5–8 annotations per image | 12 | 71 | 76.1% | 81.3% |
| 9+ annotations per image | 5 | 58 | 70.7% | 55.6% |
| From source `Testing` folder | 9 | 54 | 68.5% | 61.5% |
| From source `Training` folder | 17 | 103 | 79.6% | 74.5% |

The more crowded images and the source `Testing` subset score lower in this one-day sample. That is consistent with the visual errors, but the groups are small and do not prove the reason; the original archive folder is also not a clean experimental factor.

## Visual error review

The error montage shows the 12 most confident wrong crop predictions. Green boxes in the full-frame montage are correctly classified crops; red boxes are mistakes. These pictures are useful for finding failure patterns, not for changing test labels after seeing results.

![Most-confident crop classification errors](generated/head-tail-hog/error-montage.jpg)

![All held-out images with crop labels](generated/head-tail-hog/full-frame-test-audit.jpg)

From the montage, many mistakes appear in crowded images with multiple fish, overlapping parts, cut or partial body regions, and similar fin/body texture. This is a visual hypothesis rather than a confirmed annotation defect. The crop classifier has no surrounding fish orientation or neighboring-part context; grayscale HOG also discards color cues. Tail recall is lower than head recall (69.9% vs. 81.0%), so tails are the more common missed class in this experiment.

## Environment and model choice

The original preferred path was MediaPipe Model Maker object detection. Google now marks Model Maker deprecated and no longer actively maintained, and this PC has no Python 3.10 environment. A CPU-only PyTorch installation was attempted inside the project, but it stopped with `No space left on device`; the C: drive had about 138 MB free at that point. No Ultralytics/YOLO detector was trained and no TFLite detector was produced. Ultralytics documents YOLO11 for training, validation, and export, but the open-source package is AGPL-3.0, so its licensing must be checked before product integration ([model guide](https://docs.ultralytics.com/models/yolo11), [license guidance](https://docs.ultralytics.com/help/contributing)).

The lightweight crop classifier was then trained with the available Python/NumPy/Pillow runtime and no large framework install. Its `.npz` weights are saved for reproducibility, but cannot be loaded by the existing MediaPipe Tasks adapter. Deep object detection remains a separate next experiment after there is adequate disk space and an explicit training runtime.

## Artifacts

Generated under the ignored `ml/generated/head-tail-hog/` folder:

- `head-tail-hog.npz` — fitted linear model weights and bias.
- `metrics.json` — metrics, runtime, split counts, and limitations.
- `training-history.json` — validation loss and accuracy by epoch.
- `test-predictions.csv` — per-crop test prediction and ground-truth box.
- `stratified-analysis.json` — descriptive accuracy slices by original archive folder and annotation count.
- `error-montage.jpg` — most confident crop mistakes.
- `full-frame-test-audit.jpg` — all 26 test images with crop correctness overlays.

Tracked scripts:

- `train_hog_classifier.py` — feature extraction, training, evaluation, and error montage.
- `analyze_hog_predictions.py` — full-frame prediction visualization.

## Next experiment

For the app, the next useful model is still a full-frame `head` / `tail` object detector evaluated on a new-device smartphone set. It needs frame-level mAP/precision/recall, annotation review, and fish/session-level grouping. A cut-stage classifier needs separate temporal phone-video labels for `present_visible`, `removed_confirmed`, `occluded`, `out_of_frame`, and `unknown`; this crop experiment supplies none of those labels.
