"""
Validation metrics: per-epoch CSV (accuracy, F1, precision, recall, ROC AUC OvR),
classification report, plots (confusion matrix, ROC, confusion-row correlation).

The correlation figure uses np.corrcoef on the row-normalized confusion matrix to show
which true classes share similar predicted-class distributions (error-pattern similarity).
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any, Optional

import numpy as np
import tensorflow as tf

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.metrics import (
    accuracy_score,
    auc,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.preprocessing import label_binarize

from classification_metrics_sklearn import sklearn_metrics_from_labels

CSV_FIELDNAMES = [
    "epoch",
    "accuracy",
    "f1_macro",
    "f1_weighted",
    "precision_macro",
    "recall_macro",
    "roc_auc_ovr_macro",
    "train_loss",
    "train_accuracy",
    "val_loss",
    "val_accuracy",
]


def gather_y_true_and_probs(
    model: tf.keras.Model,
    val_ds: tf.data.Dataset,
) -> tuple[np.ndarray, np.ndarray]:
    """y_true: (N,) int labels; y_prob: (N, C) softmax probabilities."""
    y_parts: list[np.ndarray] = []
    p_parts: list[np.ndarray] = []
    for xb, yb in val_ds:
        logits = model(xb, training=False)
        prob = tf.nn.softmax(logits, axis=-1).numpy()
        yt = tf.argmax(yb, axis=-1).numpy()
        y_parts.append(yt)
        p_parts.append(prob)
    y_true = np.concatenate(y_parts, axis=0)
    y_prob = np.vstack(p_parts)
    return y_true, y_prob


def compute_sklearn_metrics(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    num_classes: int,
) -> dict[str, float]:
    y_pred = np.argmax(y_prob, axis=1)
    out: dict[str, float] = {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "f1_macro": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        "f1_weighted": float(f1_score(y_true, y_pred, average="weighted", zero_division=0)),
        "precision_macro": float(precision_score(y_true, y_pred, average="macro", zero_division=0)),
        "recall_macro": float(recall_score(y_true, y_pred, average="macro", zero_division=0)),
    }
    try:
        if num_classes < 2 or np.unique(y_true).size < 2:
            out["roc_auc_ovr_macro"] = float("nan")
        elif num_classes == 2:
            out["roc_auc_ovr_macro"] = float(roc_auc_score(y_true, y_prob[:, 1]))
        else:
            Y = label_binarize(y_true, classes=np.arange(num_classes))
            if Y.shape[1] == 1:
                out["roc_auc_ovr_macro"] = float("nan")
            else:
                out["roc_auc_ovr_macro"] = float(
                    roc_auc_score(Y, y_prob, average="macro", multi_class="ovr")
                )
    except ValueError:
        out["roc_auc_ovr_macro"] = float("nan")
    return out


# Strip trailing botanical authority from a scientific name. The two alternatives
# handle both parenthesized authorities ("(L.) L'Hér.") which are followed by an
# unparenthesized author, and trailing single/multi-word author abbreviations
# ("L.", "Scop.", "L'Hér."). Examples:
#   "Pelargonium capitatum (L.) L'Hér." → "Pelargonium capitatum"
#   "Lactuca virosa L."                 → "Lactuca virosa"
#   "Cirsium arvense (L.) Scop."        → "Cirsium arvense"
_AUTHORITY_RE = re.compile(r"\s*\(.*?\)\s*.*$|\s+[A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]+)*\.?\s*$")


def _short_label(name: str, max_len: int = 22) -> str:
    """Compress a scientific name into a tick-friendly short form.

    Takes "Pelargonium capitatum (L.) L'Hér." → "P. capitatum"
          "Lactuca virosa L."                → "L. virosa"
          "Cirsium arvense (L.) Scop."       → "C. arvense"
    Numeric ids (e.g. raw PlantNet "1355868") and single-word names are
    returned unchanged so we don't mangle anything that wasn't a binomial
    in the first place. Fallback: hard-truncate to ``max_len`` chars.
    The previous implementation chopped at 14 chars regardless, producing
    "Pelargonium ca" / "Cirsium arven" / "Linaria vulga" — which made the
    confusion matrix and ROC plots harder to read than the numeric IDs.
    """
    n = name.strip()
    if not n or n.isdigit():
        return n
    parts = n.split()
    if len(parts) >= 2 and parts[0][:1].isupper() and parts[1][:1].islower():
        short = f"{parts[0][0]}. {parts[1]}"
        if len(short) <= max_len:
            return short
    if len(n) <= max_len:
        return n
    return n[:max_len].rstrip() + "…"


def plot_loss_curves(
    history: dict[str, list[float]],
    out_dir: Path,
    *,
    filename: str = "loss_vs_epoch.png",
) -> None:
    """Plot train_loss and val_loss vs epoch — the primary over/underfitting signal.

    ``history`` is the dict returned by ``model.fit(...).history``; we only
    look up ``"loss"`` and ``"val_loss"`` so the same function works for any
    Keras training run, not just this project's CNN. Skipped silently if
    either key is missing (e.g. a run with no validation data).

    Reading the curve:
      * both lines descending and converging  → still learning (underfit if
        both still high at the last epoch);
      * train loss diving while val loss flattens or rises → overfitting
        (the gap on the right tells you how badly);
      * both flat and close to each other     → well-fit, no headroom;
      * val below train, both wandering       → batch-norm / dropout doing
        its regularization job — usually fine.

    The dashed vertical line marks the best val_loss epoch — the weights
    EarlyStopping ``restore_best_weights`` rolls back to, so it's where the
    model actually finished training even when ``len(history["loss"])``
    extends past it.
    """
    train_loss = history.get("loss")
    val_loss   = history.get("val_loss")
    if not train_loss or not val_loss:
        return

    n = min(len(train_loss), len(val_loss))
    epochs = np.arange(1, n + 1)
    tr = np.asarray(train_loss[:n], dtype=np.float64)
    va = np.asarray(val_loss[:n],   dtype=np.float64)

    fig, ax = plt.subplots(figsize=(9, 6))
    ax.plot(epochs, tr, marker="o", markersize=4, linewidth=1.8, label="train loss",      color="#1f77b4")
    ax.plot(epochs, va, marker="s", markersize=4, linewidth=1.8, label="validation loss", color="#d62728")

    best_epoch = int(np.argmin(va)) + 1
    best_val   = float(va[best_epoch - 1])
    ax.axvline(best_epoch, color="#7f7f7f", linestyle="--", linewidth=1.0, alpha=0.7)
    ax.annotate(
        f"best val_loss = {best_val:.4f}\n@ epoch {best_epoch}",
        xy=(best_epoch, best_val),
        xytext=(8, 12),
        textcoords="offset points",
        fontsize=8,
        color="#404040",
        bbox=dict(boxstyle="round,pad=0.3", facecolor="white", edgecolor="#cccccc", alpha=0.85),
    )

    final_gap = float(tr[-1] - va[-1])
    diag = "well-fit" if abs(final_gap) < 0.05 else ("overfitting" if final_gap < -0.05 else "underfitting")
    ax.text(
        0.99, 0.97,
        f"final gap (train − val) = {final_gap:+.3f}\nheuristic: {diag}",
        transform=ax.transAxes,
        ha="right", va="top",
        fontsize=8, color="#404040",
        bbox=dict(boxstyle="round,pad=0.4", facecolor="white", edgecolor="#cccccc", alpha=0.85),
    )

    ax.set_xlabel("Epoch")
    ax.set_ylabel("Loss (categorical cross-entropy)")
    ax.set_title("Learning curve — train vs validation loss")
    ax.set_xticks(epochs)
    ax.grid(True, alpha=0.25)
    ax.legend(loc="upper right" if diag != "overfitting" else "lower left")
    fig.tight_layout()
    fig.savefig(out_dir / filename, dpi=150)
    plt.close(fig)


def plot_confusion_and_correlation(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    num_classes: int,
    class_names: Optional[list[str]],
    out_dir: Path,
    max_labels_plot: int = 48,
) -> None:
    cm = confusion_matrix(y_true, y_pred, labels=np.arange(num_classes))
    row_sum = cm.sum(axis=1, keepdims=True).astype(np.float64) + 1e-8
    cm_norm = cm.astype(np.float64) / row_sum

    kcm = min(max_labels_plot, num_classes)
    fig, ax = plt.subplots(figsize=(12, 10))
    im = ax.imshow(cm_norm[:kcm, :kcm], interpolation="nearest", cmap="Blues", vmin=0, vmax=1)
    ax.set_title("Normalized confusion matrix (rows sum to 1; true=row, pred=col)")
    if class_names and len(class_names) == num_classes:
        tick = [_short_label(class_names[i]) for i in range(kcm)]
    else:
        tick = [str(i) for i in range(kcm)]
    ax.set_xticks(np.arange(kcm))
    ax.set_yticks(np.arange(kcm))
    ax.set_xticklabels(tick, rotation=90, fontsize=6)
    ax.set_yticklabels(tick, fontsize=6)
    fig.colorbar(im, ax=ax, fraction=0.046)
    fig.tight_layout()
    fig.savefig(out_dir / "confusion_matrix_normalized.png", dpi=150)
    plt.close(fig)

    if cm_norm.shape[0] >= 2:
        # Rows with zero variance (e.g. no samples for that true class) break corrcoef division.
        row_std = cm_norm.std(axis=1)
        usable = row_std > 1e-12
        if usable.sum() >= 2:
            corr_full = np.zeros((cm_norm.shape[0], cm_norm.shape[0]), dtype=np.float64)
            sub = np.corrcoef(cm_norm[usable])
            idx = np.flatnonzero(usable)
            corr_full[np.ix_(idx, idx)] = sub
            corr = np.nan_to_num(corr_full, nan=0.0)
        else:
            corr = np.eye(cm_norm.shape[0], dtype=np.float64)
        k = min(max_labels_plot, corr.shape[0])
        fig, ax = plt.subplots(figsize=(10, 8))
        im = ax.imshow(corr[:k, :k], interpolation="nearest", cmap="coolwarm", vmin=-1, vmax=1)
        ax.set_title("Correlation across rows of normalized confusion (similar mistake structure)")
        if class_names and len(class_names) == num_classes:
            tick = [_short_label(class_names[i]) for i in range(k)]
        else:
            tick = [str(i) for i in range(k)]
        ax.set_xticks(np.arange(k))
        ax.set_yticks(np.arange(k))
        ax.set_xticklabels(tick, rotation=90, fontsize=6)
        ax.set_yticklabels(tick, fontsize=6)
        fig.colorbar(im, ax=ax, fraction=0.046)
        fig.tight_layout()
        fig.savefig(out_dir / "confusion_row_correlation.png", dpi=150)
        plt.close(fig)

    np.savez_compressed(out_dir / "confusion_matrix_raw.npz", confusion=cm, labels=np.arange(num_classes))


def plot_multiclass_roc(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    num_classes: int,
    out_dir: Path,
    class_names: Optional[list[str]] = None,
    max_curves: int = 12,
) -> None:
    if num_classes < 2:
        return
    Y = label_binarize(y_true, classes=np.arange(num_classes))
    if Y.size == 0:
        return

    fig, ax = plt.subplots(figsize=(8, 7))
    try:
        fpr, tpr, _ = roc_curve(Y.ravel(), y_prob.ravel())
        auc_micro = float(auc(fpr, tpr))
        ax.plot(fpr, tpr, label=f"micro-average ROC (area ≈ {auc_micro:.3f})", linewidth=2.5)
    except ValueError:
        auc_micro = float("nan")

    counts = np.bincount(y_true, minlength=num_classes)
    order = np.argsort(-counts)
    plotted = 0
    for c in order:
        if plotted >= max_curves:
            break
        if c >= Y.shape[1]:
            continue
        y_bin = Y[:, c]
        if y_bin.sum() < 1 or (1 - y_bin).sum() < 1:
            continue
        try:
            fpr_c, tpr_c, _ = roc_curve(y_bin, y_prob[:, c])
            auc_c = float(auc(fpr_c, tpr_c))
            if class_names and len(class_names) == num_classes:
                # Strip the trailing botanical authority ("L.", "(L.) L'Hér.",
                # "Scop.", etc.) so legend entries stay scannable. Falls back
                # to the raw name when the regex strip doesn't apply (e.g.
                # the name is already short, or the input is a numeric id).
                class_label = _AUTHORITY_RE.sub("", class_names[c]).strip() or class_names[c]
            else:
                class_label = f"class {c}"
            ax.plot(fpr_c, tpr_c, alpha=0.35, label=f"{class_label} (AUC≈{auc_c:.2f})")
            plotted += 1
        except ValueError:
            continue

    ax.plot([0, 1], [0, 1], "k--", alpha=0.35)
    ax.set_xlabel("False positive rate")
    ax.set_ylabel("True positive rate")
    ax.set_title("ROC curves (one-vs-rest); micro-average + top-supported classes")
    ax.legend(loc="lower right", fontsize=6)
    fig.tight_layout()
    fig.savefig(out_dir / "roc_curves.png", dpi=150)
    plt.close(fig)


def save_classification_report_txt(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    class_names: Optional[list[str]],
    out_path: Path,
) -> None:
    labels = list(range(len(class_names))) if class_names else None
    target_names = class_names
    report = classification_report(
        y_true,
        y_pred,
        labels=labels,
        target_names=target_names,
        zero_division=0,
    )
    out_path.write_text(report, encoding="utf-8")


def save_summary_json(path: Path, metrics: dict[str, Any]) -> None:
    path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")


def evaluate_cnn_split(
    model: tf.keras.Model,
    ds: tf.data.Dataset,
    *,
    num_classes: int,
    class_names: Optional[list[str]],
    out_dir: Path,
    split_name: str,
) -> dict[str, float]:
    """
    Run sklearn metrics + classification report + confusion + ROC on one labeled dataset.
    Writes under out_dir/<split_name>/.
    """
    out_dir = Path(out_dir) / split_name
    out_dir.mkdir(parents=True, exist_ok=True)
    y_true, y_prob = gather_y_true_and_probs(model, ds)
    y_pred = np.argmax(y_prob, axis=1)
    m = compute_sklearn_metrics(y_true, y_prob, num_classes)
    save_summary_json(out_dir / "metrics_summary.json", {**m, "split": split_name, "num_classes": num_classes})
    save_classification_report_txt(
        y_true,
        y_pred,
        class_names,
        out_dir / "classification_report.txt",
    )
    plot_confusion_and_correlation(
        y_true,
        y_pred,
        num_classes,
        class_names,
        out_dir,
    )
    plot_multiclass_roc(y_true, y_prob, num_classes, out_dir, class_names=class_names)
    return m


class ValidationMetricsCallback(tf.keras.callbacks.Callback):
    """Writes metrics_per_epoch.csv; on train end saves plots + classification_report.txt."""

    def __init__(
        self,
        val_ds: tf.data.Dataset,
        num_classes: int,
        log_dir: Path,
        class_names: Optional[list[str]] = None,
        run_tag: str = "run",
    ) -> None:
        super().__init__()
        self.val_ds = val_ds
        self.num_classes = num_classes
        self.log_dir = Path(log_dir)
        self.class_names = class_names
        self.run_tag = run_tag
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._csv_path = self.log_dir / f"{run_tag}_metrics_per_epoch.csv"
        self._csv_initialized = False

    def on_epoch_end(self, epoch: int, logs: Optional[dict[str, Any]] = None) -> None:
        y_true, y_prob = gather_y_true_and_probs(self.model, self.val_ds)
        m = compute_sklearn_metrics(y_true, y_prob, self.num_classes)
        row: dict[str, Any] = {k: "" for k in CSV_FIELDNAMES}
        row["epoch"] = epoch + 1
        row["accuracy"] = f"{m['accuracy']:.6f}"
        row["f1_macro"] = f"{m['f1_macro']:.6f}"
        row["f1_weighted"] = f"{m['f1_weighted']:.6f}"
        row["precision_macro"] = f"{m['precision_macro']:.6f}"
        row["recall_macro"] = f"{m['recall_macro']:.6f}"
        roc = m["roc_auc_ovr_macro"]
        row["roc_auc_ovr_macro"] = "" if roc != roc else f"{roc:.6f}"

        if logs:
            for src, dst in [
                ("loss", "train_loss"),
                ("accuracy", "train_accuracy"),
                ("val_loss", "val_loss"),
                ("val_accuracy", "val_accuracy"),
            ]:
                v = logs.get(src)
                if v is not None:
                    row[dst] = f"{float(v):.6f}"

        write_header = not self._csv_initialized
        mode = "w" if write_header else "a"
        with open(self._csv_path, mode, newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
            if write_header:
                w.writeheader()
                self._csv_initialized = True
            w.writerow(row)

    def on_train_end(self, logs: Optional[dict[str, Any]] = None) -> None:
        y_true, y_prob = gather_y_true_and_probs(self.model, self.val_ds)
        y_pred = np.argmax(y_prob, axis=1)
        m = compute_sklearn_metrics(y_true, y_prob, self.num_classes)
        m["final"] = True
        save_summary_json(self.log_dir / f"{self.run_tag}_summary.json", {**m, "num_classes": self.num_classes})

        save_classification_report_txt(
            y_true,
            y_pred,
            self.class_names,
            self.log_dir / f"{self.run_tag}_classification_report.txt",
        )
        plot_confusion_and_correlation(
            y_true,
            y_pred,
            self.num_classes,
            self.class_names,
            self.log_dir,
        )
        plot_multiclass_roc(y_true, y_prob, self.num_classes, self.log_dir, class_names=self.class_names)
