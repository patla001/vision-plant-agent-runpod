#!/usr/bin/env python3
"""
Train a small image classifier and export TensorFlow Lite for on-device use.

Dataset layout — either **folder-per-class**::

  data/fern/*.jpg
  data/pothos/*.jpg

or **split folders** (e.g. Pl@ntNet), species as subfolders (not three classes named train/val/test)::

  data/train/<species_id>/*.jpg
  data/val/<species_id>/*.jpg
  data/test/<species_id>/*.jpg

The Android app feeds float32 NHWC [1,H,W,3] with RGB in [0, 1] (divide by 255).
This script trains with the same convention — no ImageNet mean/std in the graph.

With --k_folds > 1, stratified k-fold cross-validation runs first; then a final
model is trained for export (see --no_final_retrain).

Writes:
  - plant_classifier_deep_learning.tflite  (default; copy to app/src/main/assets/ml/)
  - plant_labels_export.txt    (copy lines to app/.../assets/ml/plant_labels.txt)
  - result/<timestamp>/   (CSV + sklearn metrics + plots; omit with --no_metric_logs)

Class index order = sorted folder names (must match plant_labels.txt line order).
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import tensorflow as tf
from sklearn.model_selection import train_test_split

import color_correction
from experiment_config import (
    collect_paths_and_labels_for_classes,
    discover_class_folder_names,
    load_json_config,
    merge_config_into_argparse_defaults,
    snapshot_full_config,
    split_summary_dict,
    stratified_train_val_test,
    validate_split_fractions,
    write_json,
)
from metrics_logging import ValidationMetricsCallback, evaluate_cnn_split, plot_loss_curves

# --- Small helpers (logging and timing) ---

_IMG_EXTS = frozenset({".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"})


def _fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    if seconds < 3600:
        m, s = divmod(int(seconds), 60)
        return f"{m}m {s}s"
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h}h {m}m {s}s"


def _log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{ts}] {msg}", flush=True)


def _log_tensorflow_devices() -> None:
    """Log TF version, visible GPUs, and enable per-process GPU memory growth."""
    _log(f"TensorFlow {tf.__version__}")
    gpus = tf.config.list_physical_devices("GPU")
    if not gpus:
        _log(
            "No GPU visible to TensorFlow — training will use CPU. "
            "For NVIDIA: install a GPU build of TensorFlow and matching CUDA/cuDNN (see tensorflow.org/install)."
        )
        return
    _log(f"TensorFlow sees {len(gpus)} GPU(s) (training should run on GPU):")
    for i, dev in enumerate(gpus):
        _log(f"  [{i}] {dev.name}")
        try:
            tf.config.experimental.set_memory_growth(dev, True)
        except Exception as ex:
            _log(f"  (could not set memory_growth for {dev.name}: {ex})")
    _log("Set memory_growth=True on each GPU so VRAM is allocated as needed.")


def _dataset_num_batches(ds: tf.data.Dataset) -> Optional[int]:
    # Used for ETA / steps-per-epoch logging; None if TF cannot infer dataset size.
    n = tf.data.experimental.cardinality(ds)
    if n == tf.data.UNKNOWN_CARDINALITY or n == tf.data.INFINITE_CARDINALITY:
        return None
    return int(n.numpy())


def _stratified_k_fold_splits(
    paths: list[str],
    labels: list[int],
    k: int,
    num_classes: int,
    seed: int,
) -> list[tuple[list[str], list[str], list[int], list[int]]]:
    """Per fold: train/val path lists and int labels (stratified by class)."""
    rng = np.random.default_rng(seed)
    by_class: dict[int, list[str]] = {c: [] for c in range(num_classes)}
    for p, y in zip(paths, labels):
        by_class[y].append(p)

    folds: list[tuple[list[str], list[str], list[int], list[int]]] = []
    for fold_idx in range(k):
        train_paths: list[str] = []
        val_paths: list[str] = []
        train_labels: list[int] = []
        val_labels: list[int] = []
        for y in range(num_classes):
            plist = list(by_class[y])
            if not plist:
                continue
            rng.shuffle(plist)
            arr = np.array(plist, dtype=object)
            splits = np.array_split(arr, k)
            val_chunk = splits[fold_idx]
            train_chunks = [splits[j] for j in range(k) if j != fold_idx]
            tr = np.concatenate(train_chunks) if train_chunks else np.array([], dtype=object)
            for path in val_chunk:
                val_paths.append(str(path))
                val_labels.append(y)
            for path in tr:
                train_paths.append(str(path))
                train_labels.append(y)
        folds.append((train_paths, val_paths, train_labels, val_labels))
    return folds


def _make_dataset_from_paths(
    paths: list[str],
    labels: list[int],
    *,
    batch_size: int,
    img_size: int,
    num_classes: int,
    shuffle: bool,
    shuffle_seed: int,
) -> tf.data.Dataset:
    path_ds = tf.data.Dataset.from_tensor_slices((paths, labels))

    def load(path: tf.Tensor, label: tf.Tensor) -> tuple[tf.Tensor, tf.Tensor]:
        img = tf.io.read_file(path)
        img = tf.io.decode_image(img, channels=3, expand_animations=False)
        img.set_shape([None, None, 3])
        img = tf.image.resize(img, [img_size, img_size])
        y = tf.one_hot(tf.cast(label, tf.int32), num_classes)
        return img, y

    ds = path_ds.map(load, num_parallel_calls=tf.data.AUTOTUNE)
    if shuffle and paths:
        ds = ds.shuffle(buffer_size=min(len(paths), 10_000), seed=shuffle_seed, reshuffle_each_iteration=True)
    return ds.batch(batch_size)


def _attach_preprocess(
    train_ds: tf.data.Dataset,
    val_ds: tf.data.Dataset,
    cc: str,
) -> tuple[tf.data.Dataset, tf.data.Dataset]:
    norm = tf.keras.layers.Rescaling(1.0 / 255.0)

    def _preprocess_batch(x: tf.Tensor, y: tf.Tensor) -> tuple[tf.Tensor, tf.Tensor]:
        x = norm(x)
        x = color_correction.apply_color_rgb01_bhwc(x, cc)
        return x, y

    train_ds = train_ds.map(_preprocess_batch, num_parallel_calls=tf.data.AUTOTUNE)
    val_ds = val_ds.map(_preprocess_batch, num_parallel_calls=tf.data.AUTOTUNE)
    return train_ds.prefetch(tf.data.AUTOTUNE), val_ds.prefetch(tf.data.AUTOTUNE)


def _attach_preprocess_one(ds: tf.data.Dataset, cc: str) -> tf.data.Dataset:
    norm = tf.keras.layers.Rescaling(1.0 / 255.0)

    def _preprocess_batch(x: tf.Tensor, y: tf.Tensor) -> tuple[tf.Tensor, tf.Tensor]:
        x = norm(x)
        x = color_correction.apply_color_rgb01_bhwc(x, cc)
        return x, y

    return ds.map(_preprocess_batch, num_parallel_calls=tf.data.AUTOTUNE).prefetch(tf.data.AUTOTUNE)


def _build_model(num_classes: int, img_size: int, dropout: float) -> tf.keras.Model:
    base = tf.keras.applications.MobileNetV2(
        input_shape=(img_size, img_size, 3),
        include_top=False,
        weights=None,  # train with [0,1] inputs (matches app); use more data for quality
        pooling="avg",
    )
    base.trainable = True
    inputs = tf.keras.Input(shape=(img_size, img_size, 3))
    # training=False: batch norm uses inference stats during forward (typical for transfer-style heads)
    x = base(inputs, training=False)
    x = tf.keras.layers.Dropout(dropout)(x)
    outputs = tf.keras.layers.Dense(num_classes, activation=None, name="logits")(x)
    return tf.keras.Model(inputs, outputs)


def _export_tflite(model: tf.keras.Model, out_path: Path) -> None:
    _log("Converting Keras model to TensorFlow Lite (float32)…")
    t0 = time.perf_counter()
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    tflite_model = converter.convert()
    conv_s = time.perf_counter() - t0
    out_path.write_bytes(tflite_model)
    _log(f"Wrote {out_path.resolve()} (convert+write took {_fmt_duration(conv_s)})")


class EpochTimingCallback(tf.keras.callbacks.Callback):
    """Logs each epoch duration and ETA for remaining epochs (if training runs to --epochs)."""

    def __init__(self, max_epochs: int, log_prefix: str = "") -> None:
        super().__init__()
        self.max_epochs = max_epochs
        self.log_prefix = log_prefix
        self._run_start: Optional[float] = None
        self._epoch_start: Optional[float] = None
        self._epoch_durations: list[float] = []

    def on_train_begin(self, logs=None) -> None:
        self._run_start = time.perf_counter()
        p = self.log_prefix
        _log(f"{p}Training started (up to {self.max_epochs} epochs; early stopping may end sooner)")

    def on_epoch_begin(self, epoch, logs=None) -> None:
        self._epoch_start = time.perf_counter()
        p = self.log_prefix
        _log(f"{p}Epoch {epoch + 1}/{self.max_epochs} …")

    def on_epoch_end(self, epoch, logs=None) -> None:
        if self._epoch_start is None:
            return
        epoch_s = time.perf_counter() - self._epoch_start
        self._epoch_durations.append(epoch_s)
        done = epoch + 1
        remaining = self.max_epochs - done
        avg = sum(self._epoch_durations) / len(self._epoch_durations)
        eta = _fmt_duration(avg * remaining) if remaining > 0 else "0s"
        total_elapsed = time.perf_counter() - self._run_start if self._run_start else 0.0
        p = self.log_prefix
        parts = [
            f"{p}Epoch {done}/{self.max_epochs} finished in {_fmt_duration(epoch_s)}",
            f"(avg epoch {_fmt_duration(avg)})",
        ]
        if remaining > 0:
            parts.append(f"ETA ~{eta} for next {remaining} epoch(s) if pace holds")
        parts.append(f"elapsed total {_fmt_duration(total_elapsed)}")
        if logs:
            loss = logs.get("loss")
            val_loss = logs.get("val_loss")
            acc = logs.get("accuracy")
            val_acc = logs.get("val_accuracy")
            metrics = []
            if loss is not None:
                metrics.append(f"loss={loss:.4f}")
            if acc is not None:
                metrics.append(f"acc={acc:.4f}")
            if val_loss is not None:
                metrics.append(f"val_loss={val_loss:.4f}")
            if val_acc is not None:
                metrics.append(f"val_acc={val_acc:.4f}")
            if metrics:
                parts.append(" | " + ", ".join(metrics))
        _log(" ".join(parts))

    def on_train_end(self, logs=None) -> None:
        if self._run_start is None:
            return
        total = time.perf_counter() - self._run_start
        p = self.log_prefix
        _log(f"{p}Training finished in {_fmt_duration(total)} ({len(self._epoch_durations)} epoch(s))")


def _train_one(
    train_ds: tf.data.Dataset,
    val_ds: tf.data.Dataset,
    *,
    num_classes: int,
    img_size: int,
    learning_rate: float,
    epochs: int,
    log_prefix: str,
    dropout: float,
    early_stopping_patience: int,
    extra_callbacks: Optional[list[tf.keras.callbacks.Callback]] = None,
) -> tuple[tf.keras.Model, tf.keras.callbacks.History]:
    _log(f"{log_prefix}Building model: MobileNetV2 + Dense({num_classes}) logits…")
    model = _build_model(num_classes, img_size, dropout)
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate),
        loss=tf.keras.losses.CategoricalCrossentropy(from_logits=True),
        metrics=["accuracy"],
    )
    # Monitor val_loss rather than val_accuracy. With 1081 PlantNet species,
    # accuracy fluctuates ±0.005 epoch-to-epoch on noise; any small lucky tick
    # resets the patience counter, so EarlyStopping never fires even when the
    # model has clearly started overfitting (training loss diving while val
    # loss climbs). Loss is monotone enough to make patience meaningful here.
    #
    # min_delta=1e-3 filters out noise-level "improvements" — without it,
    # val_loss bouncing 1.6839 → 1.6838 → 1.6840 still resets patience.
    # 1e-3 is well below the ~0.05 epoch-to-epoch swings we see in practice
    # but well above floating-point noise.
    early = tf.keras.callbacks.EarlyStopping(
        monitor="val_loss",
        mode="min",
        patience=early_stopping_patience,
        min_delta=1e-3,
        restore_best_weights=True,
    )
    timing = EpochTimingCallback(max_epochs=epochs, log_prefix=log_prefix)
    cbs: list[tf.keras.callbacks.Callback] = [early, timing]
    if extra_callbacks:
        cbs.extend(extra_callbacks)
    history = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=epochs,
        verbose=1,
        callbacks=cbs,
    )
    return model, history


def _approx_decoded_rgb_bytes(n_samples: int, img_size: int) -> int:
    """Float32 NHWC after decode+resize — upper bound for tf.data.Dataset.cache() host RAM."""
    return int(n_samples) * int(img_size) * int(img_size) * 3 * 4


def _maybe_cache_decoded_dataset(
    ds: tf.data.Dataset,
    n_samples: int,
    img_size: int,
    *,
    max_cache_mb: float,
    what: str,
) -> tf.data.Dataset:
    """
    tf.data ``cache()`` keeps decoded float tensors in host memory; large splits can OOM (tens of GiB).
    Skip cache when estimated size exceeds ``max_cache_mb`` (0 = never cache).
    """
    if max_cache_mb <= 0:
        _log(f"Skipping {what} dataset cache (--max_dataset_cache_mb=0).")
        return ds
    need = _approx_decoded_rgb_bytes(n_samples, img_size)
    max_bytes = int(max_cache_mb * 1024 * 1024)
    if need <= max_bytes:
        return ds.cache()
    _log(
        f"Skipping {what} dataset cache (~{need / (1024**3):.2f} GiB float32 RGB estimated) "
        f"because it exceeds --max_dataset_cache_mb={max_cache_mb:.0f} MiB "
        f"(raises epoch time; avoids host OOM / process kill)."
    )
    return ds


def _log_dataset_steps(train_ds: tf.data.Dataset, val_ds: tf.data.Dataset, batch_size: int) -> None:
    train_batches = _dataset_num_batches(train_ds)
    val_batches = _dataset_num_batches(val_ds)
    if train_batches is not None:
        _log(
            f"Steps per epoch: train={train_batches} batches, val={val_batches} batches "
            f"(batch_size={batch_size})"
        )
    else:
        _log(
            f"Dataset cardinality unknown; steps per epoch follow TensorFlow/Keras progress "
            f"(batch_size={batch_size})"
        )


def _resolve_metric_class_names(
    class_dirs: list[str],
    out_labels_path: Path,
    data_dir: Optional[Path] = None,
) -> list[str]:
    """
    Keep model/export label order unchanged, but use scientific names in metrics plots when available.

    Resolution order:
      1. ``plant_labels_scientific.txt`` (line-aligned with class_dirs, both 1081
         in the committed snapshot). Skipped on count mismatch — common when the
         pod's flatten produces a different subset than what the file was
         generated against.
      2. ``plantnet300K_species_id_2_name.json`` (the dataset's own id → name
         mapping). Looked up per-id, so it works even when count doesn't match.
         Searched in: data_dir.parent, data_dir.parent.parent, the script's
         own directory, and out_labels_path.parent.
      3. Raw numeric ids — produces unreadable plots labeled "1355868" /
         "1355920" etc., the failure mode this docstring is here to prevent.
    """
    if not class_dirs or not all(name.isdigit() for name in class_dirs):
        return class_dirs

    # Tier 1: line-aligned scientific names file.
    candidates = [
        out_labels_path.resolve().parent / "plant_labels_scientific.txt",
        Path("plant_labels_scientific.txt").resolve(),
    ]
    for cand in candidates:
        if not cand.is_file():
            continue
        sci = [ln.strip() for ln in cand.read_text(encoding="utf-8").splitlines() if ln.strip()]
        if len(sci) == len(class_dirs):
            _log(f"Using scientific names for metric plots: {cand}")
            return sci
        _log(
            f"Found {cand} but line count ({len(sci)}) != num_classes ({len(class_dirs)}); "
            "trying per-id JSON lookup."
        )

    # Tier 2: per-id lookup via PlantNet's id→name JSON. Survives count
    # mismatches that the line-aligned file can't, because we look up each
    # numeric id individually.
    json_candidates: list[Path] = []
    if data_dir is not None:
        json_candidates += [
            data_dir.parent / "plantnet_300K" / "plantnet300K_species_id_2_name.json",
            data_dir.parent / "plantnet300K_species_id_2_name.json",
            data_dir.parent.parent / "plantnet_300K" / "plantnet300K_species_id_2_name.json",
        ]
    json_candidates += [
        out_labels_path.resolve().parent / "plantnet300K_species_id_2_name.json",
        Path(__file__).resolve().parent / "plantnet300K_species_id_2_name.json",
        Path("/workspace/plantnet_300K/plantnet300K_species_id_2_name.json"),
    ]
    for cand in json_candidates:
        if not cand.is_file():
            continue
        try:
            mapping = json.loads(cand.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            _log(f"Could not parse {cand}: {exc}")
            continue
        if not isinstance(mapping, dict):
            continue
        resolved = [str(mapping.get(sid, sid)) for sid in class_dirs]
        hits = sum(1 for sid, name in zip(class_dirs, resolved) if name != sid)
        _log(f"Resolved {hits}/{len(class_dirs)} species names via {cand}")
        if hits > 0:
            return resolved

    _log(
        "No species-name source found — metric plots will keep numeric ids. "
        "Either commit plant_labels_scientific.txt with a matching line count, or "
        "make plantnet300K_species_id_2_name.json reachable from data_dir.parent."
    )
    return class_dirs


def main() -> None:
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--config", type=Path, default=None, help="JSON (see model_hyperparameters.json)")
    pre_args, _ = pre.parse_known_args()

    file_defaults: dict = {}
    if pre_args.config is not None:
        cfg = load_json_config(pre_args.config.resolve())
        file_defaults = merge_config_into_argparse_defaults(cfg, section="deep_learning")

    p = argparse.ArgumentParser(parents=[pre])
    p.add_argument(
        "--data_dir",
        type=Path,
        required=True,
        help="Root with one subfolder per class (folder name = label)",
    )
    p.add_argument("--img_size", type=int, default=file_defaults.get("img_size", 224))
    p.add_argument("--batch_size", type=int, default=file_defaults.get("batch_size", 16))
    p.add_argument("--epochs", type=int, default=file_defaults.get("epochs", 25))
    p.add_argument("--learning_rate", type=float, default=file_defaults.get("learning_rate", 1e-4))
    p.add_argument(
        "--dropout",
        type=float,
        default=file_defaults.get("dropout", 0.2),
        help="Dropout before the logits layer",
    )
    p.add_argument(
        "--early_stopping_patience",
        type=int,
        default=file_defaults.get("early_stopping_patience", 5),
    )
    p.add_argument(
        "--out_tflite",
        type=Path,
        default=Path("plant_classifier_deep_learning.tflite"),
    )
    p.add_argument(
        "--out_labels",
        type=Path,
        default=Path("plant_labels_export.txt"),
    )
    p.add_argument(
        "--train_fraction",
        type=float,
        default=file_defaults.get("train_fraction", 0.7),
        help="Stratified fraction for training (k_folds=1)",
    )
    p.add_argument(
        "--validation_fraction",
        type=float,
        default=file_defaults.get("validation_fraction", 0.15),
        help="Stratified fraction for validation during training",
    )
    p.add_argument(
        "--test_fraction",
        type=float,
        default=file_defaults.get("test_fraction", 0.15),
        help="Stratified held-out test set for final metrics (k_folds=1)",
    )
    p.add_argument("--seed", type=int, default=file_defaults.get("seed", 42))
    p.add_argument(
        "--color_correct",
        type=str,
        default=file_defaults.get("color_correct", "none"),
        choices=color_correction.COLOR_METHODS,
        help="Per-image illuminant correction after RGB [0,1] rescaling (use same at inference)",
    )
    p.add_argument(
        "--k_folds",
        type=int,
        default=file_defaults.get("k_folds", 1),
        help="Stratified k-fold CV: 1 = single train/val/test path split (default); "
        ">=2 runs k folds on train+val pool with test held out.",
    )
    p.add_argument(
        "--no_final_retrain",
        action="store_true",
        help="After k-fold CV only: export the best fold’s weights instead of retraining on the full split.",
    )
    p.add_argument(
        "--log_dir",
        type=Path,
        default=None,
        help="Directory for metrics CSV, JSON summary, plots, and classification report. "
        "Default: result/<UTC timestamp> when --no_metric_logs is not set.",
    )
    p.add_argument(
        "--max_dataset_cache_mb",
        type=float,
        default=file_defaults.get("max_dataset_cache_mb", 2048.0),
        help="Max estimated host RAM (MiB) for tf.data.Dataset.cache() on decoded float RGB. "
        "Large train/val sets can exceed RAM and get the process killed; use 0 to never cache.",
    )
    p.add_argument(
        "--no_metric_logs",
        action="store_true",
        help="Disable sklearn metrics CSV/plots (accuracy/F1/recall/ROC/correlation figures).",
    )
    p.add_argument(
        "--save_split_lists",
        action="store_true",
        help="Write train_paths.txt, val_paths.txt, test_paths.txt under log_dir.",
    )
    args = p.parse_args()

    if args.k_folds < 1:
        raise SystemExit("--k_folds must be >= 1")
    rel_inner_val = args.validation_fraction / (args.train_fraction + args.validation_fraction)
    if args.k_folds > 1 and rel_inner_val <= 0:
        raise SystemExit("validation_fraction must be > 0 when train_fraction+validation_fraction > 0")

    if args.k_folds == 1:
        validate_split_fractions(args.train_fraction, args.validation_fraction, args.test_fraction)

    # --- Resolve paths, discover classes, write label file (order = model class indices) ---
    _log(
        "TFLite export — "
        f"data_dir={args.data_dir!s} img_size={args.img_size} batch_size={args.batch_size} "
        f"epochs={args.epochs} lr={args.learning_rate} dropout={args.dropout} "
        f"split={args.train_fraction:.2f}/{args.validation_fraction:.2f}/{args.test_fraction:.2f} "
        f"color_correct={args.color_correct} k_folds={args.k_folds} "
        f"max_dataset_cache_mb={args.max_dataset_cache_mb}"
    )
    _log_tensorflow_devices()

    data_dir = args.data_dir.resolve()
    if not data_dir.is_dir():
        raise SystemExit(f"Not a directory: {data_dir}")

    try:
        class_dirs, nested_split_layout = discover_class_folder_names(data_dir)
    except ValueError as e:
        raise SystemExit(str(e))

    num_classes = len(class_dirs)
    if nested_split_layout:
        _log(
            f"Detected split-style layout (train/val/test → species folders): {num_classes} classes. "
            "Metrics and confusion matrices use species names, not split folder names."
        )
    args.out_labels.write_text("\n".join(class_dirs) + "\n", encoding="utf-8")
    _log(f"Wrote {args.out_labels} ({num_classes} classes, sorted folder names)")
    metric_class_names = _resolve_metric_class_names(class_dirs, args.out_labels, data_dir=data_dir)

    base_log_dir: Optional[Path] = None
    if not args.no_metric_logs:
        if args.log_dir is not None:
            base_log_dir = args.log_dir.resolve()
        else:
            base_log_dir = (
                Path("result")
                / datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_UTC")
            ).resolve()
        base_log_dir.mkdir(parents=True, exist_ok=True)
        _log(f"Metric logs (CSV, plots, reports): {base_log_dir}")

    cc = args.color_correct

    def metrics_cb(
        val_for_metrics: tf.data.Dataset,
        subdir: str,
        run_tag: str,
    ) -> Optional[ValidationMetricsCallback]:
        if args.no_metric_logs or base_log_dir is None:
            return None
        sub = base_log_dir / subdir
        return ValidationMetricsCallback(
            val_for_metrics,
            num_classes,
            sub,
            class_names=metric_class_names,
            run_tag=run_tag,
        )

    model: Optional[tf.keras.Model] = None
    test_ds_eval: Optional[tf.data.Dataset] = None
    te_paths: list[str] = []
    te_y: list[int] = []

    if args.k_folds == 1:
        _log("Stratified train/val/test split (paths; matches HOG+SVM pipeline when seed & fractions match)…")
        paths, labels = collect_paths_and_labels_for_classes(
            data_dir, class_dirs, nested_split_layout=nested_split_layout, img_exts=_IMG_EXTS
        )
        tr_p, va_p, te_p, tr_y, va_y, te_y = stratified_train_val_test(
            paths,
            labels,
            train_fraction=args.train_fraction,
            validation_fraction=args.validation_fraction,
            test_fraction=args.test_fraction,
            random_state=args.seed,
        )
        if base_log_dir is not None:
            sm = split_summary_dict(
                train_labels=tr_y,
                val_labels=va_y,
                test_labels=te_y,
                num_classes=num_classes,
                class_names=metric_class_names,
                train_fraction=args.train_fraction,
                validation_fraction=args.validation_fraction,
                test_fraction=args.test_fraction,
                seed=args.seed,
            )
            write_json(base_log_dir / "split_summary.json", sm)
            if args.save_split_lists:
                (base_log_dir / "train_paths.txt").write_text("\n".join(tr_p) + "\n", encoding="utf-8")
                (base_log_dir / "val_paths.txt").write_text("\n".join(va_p) + "\n", encoding="utf-8")
                (base_log_dir / "test_paths.txt").write_text("\n".join(te_p) + "\n", encoding="utf-8")
        _log(f"Train={len(tr_p)} | Val={len(va_p)} | Test={len(te_p)}")
        train_ds = _make_dataset_from_paths(
            tr_p,
            tr_y,
            batch_size=args.batch_size,
            img_size=args.img_size,
            num_classes=num_classes,
            shuffle=True,
            shuffle_seed=args.seed,
        )
        val_ds = _make_dataset_from_paths(
            va_p,
            va_y,
            batch_size=args.batch_size,
            img_size=args.img_size,
            num_classes=num_classes,
            shuffle=False,
            shuffle_seed=args.seed,
        )
        test_ds_eval = _make_dataset_from_paths(
            te_p,
            te_y,
            batch_size=args.batch_size,
            img_size=args.img_size,
            num_classes=num_classes,
            shuffle=False,
            shuffle_seed=args.seed,
        )
        train_ds, val_ds = _attach_preprocess(train_ds, val_ds, cc)
        test_ds_eval = _attach_preprocess_one(test_ds_eval, cc)
        if not args.no_metric_logs:
            val_ds = _maybe_cache_decoded_dataset(
                val_ds,
                len(va_p),
                args.img_size,
                max_cache_mb=args.max_dataset_cache_mb,
                what="validation",
            )
        _log_dataset_steps(train_ds, val_ds, args.batch_size)
        mcb = metrics_cb(val_ds, "single_split", "metrics")
        model, history = _train_one(
            train_ds,
            val_ds,
            num_classes=num_classes,
            img_size=args.img_size,
            learning_rate=args.learning_rate,
            epochs=args.epochs,
            log_prefix="",
            dropout=args.dropout,
            early_stopping_patience=args.early_stopping_patience,
            extra_callbacks=[mcb] if mcb else None,
        )
        # Learning curve — the primary over/underfitting signal. Saved at the
        # top of base_log_dir so it's alongside the run-level summaries
        # (hyperparameters_snapshot.json, metrics_train_val_test.json) and
        # gets uploaded to the GitHub Release by collect_artifact_files.
        if base_log_dir is not None:
            plot_loss_curves(history.history, base_log_dir)
    else:
        _log(f"Stratified {args.k_folds}-fold CV: hold out test ({args.test_fraction:.2f}), then fold the rest…")
        paths, labels = collect_paths_and_labels_for_classes(
            data_dir, class_dirs, nested_split_layout=nested_split_layout, img_exts=_IMG_EXTS
        )
        _log(f"Found {len(paths)} images across {num_classes} classes.")
        paths_a = np.array(paths, dtype=object)
        labels_a = np.array(labels, dtype=np.int64)
        tv_paths, te_paths_a, tv_labels, te_labels = train_test_split(
            paths_a,
            labels_a,
            test_size=args.test_fraction,
            stratify=labels_a,
            random_state=args.seed,
        )
        tv_paths = tv_paths.tolist()
        te_paths = te_paths_a.tolist()
        tv_labels = tv_labels.tolist()
        te_y = te_labels.tolist()
        if base_log_dir is not None:
            sm = {
                "seed": args.seed,
                "test_fraction": args.test_fraction,
                "k_folds": args.k_folds,
                "train_val_pool": len(tv_paths),
                "test_holdout": len(te_paths),
            }
            write_json(base_log_dir / "split_summary_kfold.json", sm)
            if args.save_split_lists:
                (base_log_dir / "train_val_pool_paths.txt").write_text("\n".join(tv_paths) + "\n", encoding="utf-8")
                (base_log_dir / "test_paths.txt").write_text("\n".join(te_paths) + "\n", encoding="utf-8")
        fold_splits = _stratified_k_fold_splits(tv_paths, tv_labels, args.k_folds, num_classes, args.seed)

        best_val_acc = -1.0
        best_fold_idx = -1
        best_weights: Optional[list[np.ndarray]] = None
        fold_scores: list[float] = []

        for fold_idx, (tr_p, va_p, tr_y, va_y) in enumerate(fold_splits):
            prefix = f"[Fold {fold_idx + 1}/{args.k_folds}] "
            if not tr_p or not va_p:
                raise SystemExit(
                    f"{prefix}empty train or validation set — use fewer folds or add more images per class."
                )
            tr_classes = set(tr_y)
            if len(tr_classes) < num_classes:
                raise SystemExit(
                    f"{prefix}training set is missing some classes (each class needs at least "
                    f"--k_folds images for stratified folds to work). Reduce --k_folds or add images."
                )
            _log(f"{prefix}train={len(tr_p)} val={len(va_p)}")
            train_ds = _make_dataset_from_paths(
                tr_p,
                tr_y,
                batch_size=args.batch_size,
                img_size=args.img_size,
                num_classes=num_classes,
                shuffle=True,
                shuffle_seed=args.seed + fold_idx,
            )
            val_ds = _make_dataset_from_paths(
                va_p,
                va_y,
                batch_size=args.batch_size,
                img_size=args.img_size,
                num_classes=num_classes,
                shuffle=False,
                shuffle_seed=args.seed,
            )
            train_ds, val_ds = _attach_preprocess(train_ds, val_ds, cc)
            if not args.no_metric_logs:
                val_ds = _maybe_cache_decoded_dataset(
                    val_ds,
                    len(va_p),
                    args.img_size,
                    max_cache_mb=args.max_dataset_cache_mb,
                    what="validation",
                )
            _log_dataset_steps(train_ds, val_ds, args.batch_size)

            mcb = metrics_cb(val_ds, f"fold_{fold_idx + 1}", "metrics")
            fmodel, hist = _train_one(
                train_ds,
                val_ds,
                num_classes=num_classes,
                img_size=args.img_size,
                learning_rate=args.learning_rate,
                epochs=args.epochs,
                log_prefix=prefix,
                dropout=args.dropout,
                early_stopping_patience=args.early_stopping_patience,
                extra_callbacks=[mcb] if mcb else None,
            )
            vacc = max(hist.history["val_accuracy"])
            fold_scores.append(float(vacc))
            _log(f"{prefix}best val_accuracy={vacc:.4f}")
            if vacc > best_val_acc:
                best_val_acc = vacc
                best_fold_idx = fold_idx
                best_weights = fmodel.get_weights()

        assert best_weights is not None
        mean_acc = float(np.mean(fold_scores))
        std_acc = float(np.std(fold_scores))
        _log(
            f"K-fold summary: val_accuracy mean={mean_acc:.4f} std={std_acc:.4f} "
            f"per-fold={[round(s, 4) for s in fold_scores]} (best fold {best_fold_idx + 1})"
        )

        if args.no_final_retrain:
            _log("Exporting model from best fold (--no_final_retrain).")
            model = _build_model(num_classes, args.img_size, args.dropout)
            model.set_weights(best_weights)
        else:
            _log(
                "Final training for export: train/val monitor split from train+val pool "
                f"(monitor val fraction of pool ≈ {rel_inner_val:.4f})…"
            )
            tr_fit, va_fit, tr_y_fit, va_y_fit = train_test_split(
                np.array(tv_paths, dtype=object),
                np.array(tv_labels, dtype=np.int64),
                test_size=rel_inner_val,
                stratify=np.array(tv_labels, dtype=np.int64),
                random_state=args.seed + 2,
            )
            tr_fit = tr_fit.tolist()
            va_fit = va_fit.tolist()
            tr_y_fit = tr_y_fit.tolist()
            va_y_fit = va_y_fit.tolist()
            train_ds = _make_dataset_from_paths(
                tr_fit,
                tr_y_fit,
                batch_size=args.batch_size,
                img_size=args.img_size,
                num_classes=num_classes,
                shuffle=True,
                shuffle_seed=args.seed,
            )
            val_ds = _make_dataset_from_paths(
                va_fit,
                va_y_fit,
                batch_size=args.batch_size,
                img_size=args.img_size,
                num_classes=num_classes,
                shuffle=False,
                shuffle_seed=args.seed,
            )
            train_ds, val_ds = _attach_preprocess(train_ds, val_ds, cc)
            if not args.no_metric_logs:
                val_ds = _maybe_cache_decoded_dataset(
                    val_ds,
                    len(va_fit),
                    args.img_size,
                    max_cache_mb=args.max_dataset_cache_mb,
                    what="validation",
                )
            _log_dataset_steps(train_ds, val_ds, args.batch_size)
            mcb = metrics_cb(val_ds, "final_retrain", "metrics")
            model, history = _train_one(
                train_ds,
                val_ds,
                num_classes=num_classes,
                img_size=args.img_size,
                learning_rate=args.learning_rate,
                epochs=args.epochs,
                log_prefix="[Final] ",
                dropout=args.dropout,
                early_stopping_patience=args.early_stopping_patience,
                extra_callbacks=[mcb] if mcb else None,
            )
            if base_log_dir is not None:
                plot_loss_curves(history.history, base_log_dir)

        test_ds_eval = _make_dataset_from_paths(
            te_paths,
            te_y,
            batch_size=args.batch_size,
            img_size=args.img_size,
            num_classes=num_classes,
            shuffle=False,
            shuffle_seed=args.seed,
        )
        test_ds_eval = _attach_preprocess_one(test_ds_eval, cc)

    assert model is not None

    if not args.no_metric_logs and base_log_dir is not None:
        split_root = base_log_dir / "split_metrics"
        m_train: dict[str, float] = {}
        m_val: dict[str, float] = {}
        m_test: dict[str, float] = {}
        if args.k_folds == 1:
            train_ds_metric = _make_dataset_from_paths(
                tr_p,
                tr_y,
                batch_size=args.batch_size,
                img_size=args.img_size,
                num_classes=num_classes,
                shuffle=False,
                shuffle_seed=args.seed,
            )
            val_ds_metric = _make_dataset_from_paths(
                va_p,
                va_y,
                batch_size=args.batch_size,
                img_size=args.img_size,
                num_classes=num_classes,
                shuffle=False,
                shuffle_seed=args.seed,
            )
            train_ds_metric, val_ds_metric = _attach_preprocess(train_ds_metric, val_ds_metric, cc)
            train_ds_metric = _maybe_cache_decoded_dataset(
                train_ds_metric,
                len(tr_p),
                args.img_size,
                max_cache_mb=args.max_dataset_cache_mb,
                what="train (metrics pass)",
            )
            val_ds_metric = _maybe_cache_decoded_dataset(
                val_ds_metric,
                len(va_p),
                args.img_size,
                max_cache_mb=args.max_dataset_cache_mb,
                what="validation (metrics pass)",
            )
            m_train = evaluate_cnn_split(
                model,
                train_ds_metric,
                num_classes=num_classes,
                class_names=metric_class_names,
                out_dir=split_root,
                split_name="train",
            )
            m_val = evaluate_cnn_split(
                model,
                val_ds_metric,
                num_classes=num_classes,
                class_names=metric_class_names,
                out_dir=split_root,
                split_name="validation",
            )
        if test_ds_eval is not None:
            n_test = len(te_p) if args.k_folds == 1 else len(te_paths)
            test_ds_metric = _maybe_cache_decoded_dataset(
                test_ds_eval,
                n_test,
                args.img_size,
                max_cache_mb=args.max_dataset_cache_mb,
                what="test",
            )
            m_test = evaluate_cnn_split(
                model,
                test_ds_metric,
                num_classes=num_classes,
                class_names=metric_class_names,
                out_dir=split_root,
                split_name="test",
            )
        write_json(
            base_log_dir / "metrics_train_val_test.json",
            {
                "method": "cnn_mobilenetv2",
                "img_size": args.img_size,
                "batch_size": args.batch_size,
                "epochs_requested": args.epochs,
                "learning_rate": args.learning_rate,
                "dropout": args.dropout,
                "early_stopping_patience": args.early_stopping_patience,
                "color_correct": args.color_correct,
                "k_folds": args.k_folds,
                "metrics": {
                    "train": {**m_train, "note": "in-sample; optimistic vs val/test"} if m_train else None,
                    "validation": m_val if m_val else None,
                    "test": {**m_test, "note": "held-out"} if m_test else None,
                },
            },
        )
        hp_snapshot = snapshot_full_config(
            pre_args.config.resolve() if pre_args.config else None,
            {k: str(getattr(args, k)) if isinstance(getattr(args, k), Path) else getattr(args, k) for k in vars(args)},
        )
        write_json(base_log_dir / "hyperparameters_snapshot.json", hp_snapshot)

    _export_tflite(model, args.out_tflite)
    print()
    _log("Next:")
    print(f"  1) Copy {args.out_tflite.name} -> app/src/main/assets/ml/ (e.g. plant_classifier.tflite)")
    print(f"  2) Copy {args.out_labels.name} lines into app/src/main/assets/ml/plant_labels.txt")
    print("  3) Remove plant_classifier.onnx from assets if present (TFLite takes precedence).")


if __name__ == "__main__":
    main()
