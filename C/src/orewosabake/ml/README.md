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

An attempt to install CPU PyTorch for YOLO training ran out of disk space. The computer had about 138 MB free at the time, and no supported Python 3.10 environment for the older Model Maker route. `nvidia-smi` was not available, so GPU availability was not verified; this experiment used CPU. No deep detector or TFLite model was produced. The HOG baseline is a useful low-cost experiment while that environment is unavailable, but it does not replace the full-frame detector described below.

## Prepare or train

The current desktop has Python 3.12 and 3.14, while the last published Model Maker package lists Python 3.8–3.10. The data-conversion-only mode works with the bundled Python and Pillow:

```powershell
python ml/train_detector.py --prepare-only --force
```

It creates the converted COCO images/labels under ignored `ml/generated/coco/`, plus `split-manifest.json` and `prepare-summary.json`. `--force` only replaces that generated COCO conversion.

For the training experiment, use a Python 3.10 environment:

```powershell
py -3.10 -m venv ml/.venv
ml/.venv/Scripts/python.exe -m pip install -r ml/requirements-model-maker.txt
ml/.venv/Scripts/python.exe ml/train_detector.py --force
```

The model and metrics are written to ignored `ml/generated/output/`. Model Maker uses transfer learning and COCO evaluation metrics; the script reports validation and group-held-out test metrics separately. No QAT or aggressive quantization is included in this first run, so the float32 exported artifact can be checked for compatibility first.

## Browser model adapter

After training and compatibility review, copy `ml/generated/output/head-tail.tflite` to `apps/web/public/models/head-tail.tflite`. The browser adapter loads that file as a MediaPipe Tasks Vision Object Detector and accepts decoded video frames. The UI remains in mock mode until a model and camera lifecycle are intentionally connected.

MediaPipe's web `detectForVideo()` call is synchronous and can block the main thread. The product design samples frames around once or twice per second, allows one inference at a time, and should move inference to a worker only if measurements show the main thread is blocked. The adapter does not request camera permission, upload frames, or control guide progression.

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
