# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CS659 course project comparing **classical (HOG + SVM)** vs. **deep learning (MobileNetV2 CNN)** approaches for plant species image classification, with a TensorFlow Lite export pipeline targeting Android deployment.

## Setup

```bash
cd DeepLearning-tensorFlowLite
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-tflite.txt
```

For GPU-accelerated training (NVIDIA only):
```bash
pip install "tensorflow[and-cuda]>=2.14.0,<2.19.0"
```

Python 3.10+ required (3.11 tested). No linting or test frameworks are configured.

## Key Commands

**Train CNN (MobileNetV2 → TFLite export):**
```bash
python train_export_tflite.py --data_dir /path/to/data --color_correct none
```

**Train classical baseline (HOG + SVM):**
```bash
python train_hog_svm.py --data_dir /path/to/data
```

**Run inference on a single image:**
```bash
python infer_plant_tflite.py --model plant_classifier_deep_learning.tflite \
  --labels plant_labels_scientific.txt --image ./Lactuca-virosa.jpg --top_k 10
```

**Prepare PlantNet-300K dataset (convert to folder-per-class layout):**
```bash
python flatten_plantnet.py --source /path/to/plantnet_300K/images --out /path/to/flattened
python map_plantnet_ids_to_names.py  # optionally rename numeric IDs to scientific names
```

**Re-export a saved HOG+SVM pipeline to TFLite:**
```bash
python export_hog_svm_tflite.py
```

## Architecture

### Two-Pipeline Design

Both pipelines share the same data loading and splitting logic (`experiment_config.py`) for fair comparison.

**Pipeline A — Deep Learning (`train_export_tflite.py`):**
- MobileNetV2 backbone + small dense classification head
- Input: 224×224 float32 RGB images normalized to [0, 1]
- Optional color correction (gray-world or max-RGB) applied at preprocessing time
- Supports stratified k-fold cross-validation (`--k_folds`)
- Exports to `.tflite` (float32) with embedded label metadata

**Pipeline B — Classical (`train_hog_svm.py`):**
- HOG feature extraction on grayscale images → StandardScaler → Linear/RBF SVM
- Default: scikit-image CPU HOG; pass `--gpu-hog` to use `hog_tf.py` (TensorFlow GPU implementation)
- TFLite export available only for linear kernel via `export_hog_svm_tflite.py`
- Trained model saved as `hog_svm_model.joblib`

### Configuration

`model_hyperparameters.json` defines defaults for both pipelines. CLI flags override JSON values. Key shared settings:

- `split.seed`, `train_fraction` (0.7), `validation_fraction` (0.15), `test_fraction` (0.15)
- `img_size`: 224 (both pipelines resize to this)

### Data Format

Expects **folder-per-class** layout: `data/<species_name>/*.jpg`. Supported image formats: `.jpg`, `.jpeg`, `.png`, `.bmp`, `.gif`, `.webp`. PlantNet-300K's split-based layout must be flattened first with `flatten_plantnet.py`.

### Metrics & Outputs

All training artifacts land in `result/<timestamp>_UTC/`:
- Per-epoch CSV (accuracy, F1 macro/weighted, precision, recall, ROC AUC)
- Classification reports, confusion matrices (raw + row-normalized), ROC curves
- `hyperparameters_snapshot.json`, `split_summary.json`

Label files (`plant_labels_export.txt`, `plant_labels_scientific.txt`): line index = class ID, used by the inference script and embedded in TFLite metadata.

### Module Responsibilities

| File | Role |
|------|------|
| `experiment_config.py` | Load JSON config, discover classes, build stratified splits |
| `metrics_logging.py` | Per-epoch CSV logging + post-training plots (CNN pipeline) |
| `classification_metrics_sklearn.py` | sklearn-only metrics helper — imported by HOG pipeline *before* TensorFlow to avoid GPU init conflicts |
| `color_correction.py` | Gray-world / max-RGB white balance on NHWC float32 [0,1] tensors |
| `hog_tf.py` | TensorFlow HOG implementation (matches scikit-image math, GPU-capable) |
