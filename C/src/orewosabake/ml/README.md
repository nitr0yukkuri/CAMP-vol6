# MediaPipe head/tail detector experiment

## Scope and model choice

The first experiment is **object detection for `head` and `tail`**, using the local 200-image Mendeley YOLO dataset. It does not train `whole_fish`, `head_removed`, or `filleted` states: those labels do not exist in this dataset.

The planned path is:

1. Convert the existing YOLO labels to the COCO format accepted by MediaPipe Model Maker.
2. Fine-tune its MobileNetV2 I320 object detector and evaluate on complete held-out capture dates.
3. Export a TFLite model with metadata, then use MediaPipe Tasks Vision `ObjectDetector` in the browser.

MediaPipe Tasks Vision is the on-device inference runtime; it does not learn fish categories by itself. Google's own documentation still shows the Model Maker transfer-learning path and describes TFLite export with metadata, but also marks Model Maker deprecated and no longer actively maintained. It is suitable here as an isolated experiment, not a long-term training platform. The exported model must be loaded successfully by the web task before calling it compatible.

## Split and leakage analysis

The source archive's `Training` and `Testing` folders share seven capture dates. Filenames also show training and test images taken in the same short time windows on several of those dates. A plain evaluation on its original 40-image test folder could therefore reward recognition of the same capture setup or near-identical sequence. Grouping by date avoids that direct overlap, but the source provides no fish-ID or recording-session labels; repeated views of the same individual across dates cannot be ruled out.

`train_detector.py` combines both source folders and holds out full dates instead:

| Split | Capture-day group | Images | head boxes | tail boxes |
|---|---|---:|---:|---:|
| Train | All except the two dates below | 153 | 619 | 490 |
| Validation | 2019-10-14 | 21 | 21 | 21 |
| Test | 2019-11-14 | 26 | 84 | 73 |

Every image from one capture date stays in one split. This is more conservative than the archive's provided split but is still **not a new-device or smartphone test**. The two held-out dates are small and should not be treated as robust performance evidence.

The converter clips YOLO boxes to image bounds. In the source, boxes calculated just beyond an edge exceed it by at most 0.00042 pixels due to decimal rounding; this does not materially change them.

## Executed CPU image-learning baseline

An initial model has now been trained from the existing annotations: HOG features plus L2-regularized logistic regression classify an **already-cropped** region as `head` or `tail`. It does not detect parts in a full image. Training used 1,109 annotated train crops with horizontal-flip augmentation (2,218 examples); the best validation loss was at epoch 13, with early stopping after 31 epochs.

| Set | Crops | Accuracy | Balanced accuracy | Macro F1 |
|---|---:|---:|---:|---:|
| Validation | 42 | 88.1% | 88.1% | 88.0% |
| Capture-day-held-out test | 157 | 75.8% | 75.4% | 75.5% |

On test crops, head recall was 81.0% and tail recall was 69.9%. The test covers 26 images from one capture day, so these are preliminary crop-classification results, not expected app accuracy. The complete method, confusion matrix, image-wise breakdown, and error montages are in [hog-experiment-report.md](hog-experiment-report.md).

Run the lightweight experiment with a Python environment that has NumPy and Pillow:

```powershell
python -m pip install -r ml/requirements-hog.txt
python ml/train_hog_classifier.py
python ml/analyze_hog_predictions.py
```

Model and analysis artifacts are written under ignored `ml/generated/head-tail-hog/`. The model is a small `.npz` linear classifier; the MediaPipe adapter does not load it.

An earlier attempt to install CPU PyTorch for YOLO training ran out of disk space. The MediaPipe Model Maker experiment below instead uses an isolated Python 3.10 environment in WSL, stored under the Linux home directory; training and converted data remain in ignored project output. `nvidia-smi` was unavailable, so this run uses CPU. The HOG baseline remains a separate crop-classification baseline and does not replace the full-frame detector.

## Trained full-frame detector

The 30-epoch MobileNetV2 I320 model exported successfully and loaded through MediaPipe Tasks Vision `ObjectDetector`. The confidence threshold is `0.35` (selected on the validation split by macro F1 at IoU 0.5). Evaluation now uses the same `maxResults=12` cap as the browser adapter.

| Capture-day-held-out split | Images | head P / R / F1 | tail P / R / F1 | Macro F1 |
| --- | ---: | ---: | ---: | ---: |
| Validation, 2019-10-14 | 21 | 0.909 / 0.952 / 0.930 | 0.800 / 0.762 / 0.781 | 0.855 |
| Test, 2019-11-14 | 26 | 0.944 / 0.810 / 0.872 | 0.839 / 0.644 / 0.729 | 0.800 |

With the browser's 12-result cap, the held-out test result has custom COCO-style AP50 `0.7943` and AP50:95 `0.4720`. Matching uses same-class boxes at IoU 0.5; AP uses 101-point interpolation. With a diagnostic cap of 100, AP50 is `0.8125`, while thresholded macro F1 stays `0.8002` at both caps. This shows that the cap removes some low-score detections used by AP but did not change detections above the selected `0.35` threshold on this test set. The standard Model Maker evaluator reported AP50 `0.815`, close to the uncapped custom result.

The per-image error analysis finds 26 missed tail boxes: 13 are mainly localization errors (best same-class IoU below 0.5), 11 have an overlapping candidate below the score threshold, and 2 have no overlapping same-class candidate. Head misses include 5 likely head/tail confusions. These counts describe only 26 images from one held-out capture day. The dataset has no fish IDs or session labels, so they are not 26 confirmed independent fish; they do not predict accuracy on a phone or kitchen setup. The detailed threshold sweep, image-level false positives/negatives, environment versions, data-label checksums, and model SHA-256 are in ignored `ml/generated/output/metrics.json`. The 18 highest-error frames with ground-truth and predicted boxes are in ignored [error-analysis.png](generated/output/error-analysis.png).

The exported float32 model is 10,457,546 bytes (about 10.0 MiB), with SHA-256 `17b0356cf1b14c3956627be109faa2d0ada73a916397d88ed32d6c96eb78ced6`. It is copied to `apps/web/public/models/head-tail.tflite`, which is ignored by Git. A Vite build on a machine with that file includes it as a static asset; a clean checkout or CI without it does not. It is under Cloudflare Workers' [25 MiB per-static-asset limit](https://developers.cloudflare.com/workers/platform/limits/). The browser samples video at 1 Hz. The latest WSL CPU/XNNPACK measurement, including image decode, was median `70.06 ms` and p95 `81.91 ms` across 26 images; this local benchmark varies by machine and is not a browser or phone measurement.

## Source data

The raw Mendeley archive and extracted images are intentionally excluded from Git. Follow [data/raw/README.md](../data/raw/README.md) to download version 1 and extract it under data/raw/mendeley-head-tail/extracted/. The conversion expects Training/ and Testing/ directly under that folder, with one matching YOLO .txt file for every .jpg image. A clean checkout must obtain this source data before running conversion or training.
## Prepare or train

The last published Model Maker package lists Python 3.8–3.10; the current Windows Python is newer. Data conversion alone works with a Python environment that has Pillow:

```powershell
python ml/train_detector.py --prepare-only --force
```

It creates the converted COCO images/labels under ignored `ml/generated/coco/`, plus `split-manifest.json` and `prepare-summary.json`. `--force` only replaces that generated COCO conversion.

For training, use Ubuntu on WSL. From the project directory in WSL, prepare the isolated Python 3.10 environment and pinned dependencies:

```bash
bash ml/setup-wsl-training.sh
```

The script prints the exact command to train. The pinned dependencies resolve the Python/Windows TensorFlow Text conflict and MediaPipe metadata package incompatibilities seen with newer releases. Training takes place on CPU. Model Maker uses transfer learning and COCO evaluation metrics; validation and capture-day-held-out test metrics are reported separately. The exported float32 TFLite file is also loaded and run through MediaPipe Tasks before it is copied to the web public model path. `--evaluate-only` repeats the compatibility check, selects a score threshold by validation macro F1 at IoU 0.5 using the browser's 12-result cap, compares with a 100-result diagnostic cap, and reports per-class metrics and image-level failure causes on the independent held-out test split without training again. It also creates a box-overlay montage for the highest-error frames. Generated datasets, checkpoints, metrics, the montage, and the model file are ignored by Git.

## Browser model adapter

The web client checks for `apps/web/public/models/head-tail.tflite` when the camera starts and loads it through MediaPipe Tasks Vision `ObjectDetector` in `VIDEO` mode inside a dedicated Web Worker. It samples the local camera about once per second, scales each frame proportionally to a maximum dimension of 832 pixels (matching the source image size), transfers one `ImageBitmap` at a time to that worker, and terminates the worker when the camera/guide is stopped. The MediaPipe WASM files come from the lockfile-pinned npm package and are copied into the ignored public directory before dev/build, then served from the same origin as the app. This removes the runtime CDN dependency. Frames stay inside the browser and are not sent to the API or an external service. The result is schema-validated when it crosses back to the React thread, and old results are discarded. The guide's manual session remains independent of detections, and a missing head/tail detection is not treated as evidence that a part was removed.

MediaPipe's web `detectForVideo()` call is synchronous, so it runs in the worker to keep the React thread responsive. The current cadence is 1 Hz with at most one frame in flight. Phone-specific latency and camera compatibility still need measurement.

## What the experiment cannot answer

- It detects visible head/tail regions, not whether a missing part was cut off, hidden by a hand/tool, or outside the frame.
- It cannot recognize preparation stages because no stage labels are present.
- It cannot establish that a knife action is safe or complete.
- Its public test images do not represent the intended smartphone, board, lighting, hand, knife, or single-fish setup.

Stage recognition needs phone-view frames with confirmed stage labels, explicit visibility labels (`present_visible`, `removed_confirmed`, `occluded`, `out_of_frame`, `unknown`), and data splits grouped by both fish and capture session.

## Official references

- Training source: Eko Prasetyo, Nanik Suciati, and Chastine Fatichah, [Dataset for Detecting Head and Tail of Fish](https://data.mendeley.com/datasets/7m2yzmpcft/1), v1 (2021), DOI `10.17632/7m2yzmpcft.1`, CC BY 4.0. If distributing the trained model, preserve attribution to the dataset and identify the model as trained/adapted from it; check the dataset page for its current terms.
- [MediaPipe Model Maker status and limitations](https://developers.google.com/edge/mediapipe/solutions/model_maker)
- [MediaPipe Object Detector customization and TFLite export](https://developers.google.com/edge/mediapipe/solutions/customization/object_detector)
- [MediaPipe Tasks Object Detector web guide and model requirements](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js)
- [Model Maker PyPI release and Python classifiers](https://pypi.org/project/mediapipe-model-maker/)
