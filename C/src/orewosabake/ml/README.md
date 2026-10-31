# MediaPipe head/tail detector experiment

## Scope and model choice

The first experiment is **object detection for `head` and `tail`**, using the local 200-image Mendeley YOLO dataset. It does not train `whole_fish`, `head_removed`, or `filleted` states: those labels do not exist in this dataset.

The planned path is:

1. Convert the existing YOLO labels to the COCO format accepted by MediaPipe Model Maker.
2. Fine-tune its MobileNetV2 I320 object detector and evaluate on complete held-out capture dates.
3. Export a TFLite model with metadata, then use MediaPipe Tasks Vision `ObjectDetector` in the browser.

MediaPipe Tasks Vision is the on-device inference runtime; it does not learn fish categories by itself. Google's own documentation still shows the Model Maker transfer-learning path and describes TFLite export with metadata, but also marks Model Maker deprecated and no longer actively maintained. It is suitable here as an isolated experiment, not a long-term training platform. The exported model must be loaded successfully by the web task before calling it compatible.

## Split and leakage analysis

The source archive's `Training` and `Testing` folders share seven capture dates. Filenames also show training and test images taken in the same short time windows on several of those dates. A plain evaluation on its original 40-image test folder could therefore reward recognition of the same capture setup or near-identical sequence.

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

The script prints the exact command to train. The pinned dependencies resolve the Python/Windows TensorFlow Text conflict and MediaPipe metadata package incompatibilities seen with newer releases. Training takes place on CPU. Model Maker uses transfer learning and COCO evaluation metrics; validation and capture-day-held-out test metrics are reported separately. The exported float32 TFLite file is also loaded and run through MediaPipe Tasks before it is copied to the web public model path. Generated datasets, checkpoints, metrics, and the model file are ignored by Git.

## Browser model adapter

The web client checks for `apps/web/public/models/head-tail.tflite` when the camera starts and loads it through MediaPipe Tasks Vision `ObjectDetector` in `VIDEO` mode. It samples the local camera about once per second, draws head/tail boxes, and disposes the detector when the camera/guide is stopped or the page is hidden. Only the model and MediaPipe WASM runtime are fetched; video frames are not sent to the API. The guide's manual session remains independent of detections, and a missing head/tail detection is not treated as evidence that a part was removed.

MediaPipe's web `detectForVideo()` call is synchronous and can block the main thread. The current implementation samples at 1 Hz and allows one inference at a time as an initial low-load check. A dedicated worker should be evaluated with frame-time measurements before increasing that rate.

## What the experiment cannot answer

- It detects visible head/tail regions, not whether a missing part was cut off, hidden by a hand/tool, or outside the frame.
- It cannot recognize preparation stages because no stage labels are present.
- It cannot establish that a knife action is safe or complete.
- Its public test images do not represent the intended smartphone, board, lighting, hand, knife, or single-fish setup.

Stage recognition needs phone-view frames with confirmed stage labels, explicit visibility labels (`present_visible`, `removed_confirmed`, `occluded`, `out_of_frame`, `unknown`), and data splits grouped by both fish and capture session.

## Official references

- [MediaPipe Model Maker status and limitations](https://developers.google.com/edge/mediapipe/solutions/model_maker)
- [MediaPipe Object Detector customization and TFLite export](https://developers.google.com/edge/mediapipe/solutions/customization/object_detector)
- [MediaPipe Tasks Object Detector web guide and model requirements](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js)
- [Model Maker PyPI release and Python classifiers](https://pypi.org/project/mediapipe-model-maker/)
