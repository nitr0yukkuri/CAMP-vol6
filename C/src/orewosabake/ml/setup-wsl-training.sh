#!/usr/bin/env bash

# Prepare the deprecated MediaPipe Model Maker experiment in an isolated
# Linux Python environment. Run this script from WSL; do not install these
# dependencies into the React/Node workspace or the user's global Python.
set -euo pipefail

ML_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GENERATED_DIR="$ML_DIR/generated"
ENV_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/orewosabake/model-maker"
UV_BIN="$GENERATED_DIR/uv-tool/uv"
VENV_DIR="$ENV_DIR/venv"
CACHE_DIR="$ENV_DIR/cache"

mkdir -p "$GENERATED_DIR/uv-tool"
mkdir -p "$ENV_DIR"
if [[ ! -x "$UV_BIN" ]]; then
  installer="$GENERATED_DIR/uv-install.sh"
  curl --fail --location --silent --show-error https://astral.sh/uv/install.sh -o "$installer"
  UV_INSTALL_DIR="$GENERATED_DIR/uv-tool" UV_NO_MODIFY_PATH=1 sh "$installer"
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$UV_BIN" venv --python 3.10 "$VENV_DIR"
fi
UV_CACHE_DIR="$CACHE_DIR" "$UV_BIN" pip install \
  --python "$VENV_DIR/bin/python" \
  -r "$ML_DIR/requirements-model-maker.txt"

"$VENV_DIR/bin/python" --version
"$VENV_DIR/bin/python" -c 'from mediapipe_model_maker import object_detector; import tensorflow as tf; print("MediaPipe Object Detector training is ready"); print("TensorFlow", tf.__version__)'

printf '\nEnvironment ready. Train with:\n  %q %q --force\n' "$VENV_DIR/bin/python" "$ML_DIR/train_detector.py"
