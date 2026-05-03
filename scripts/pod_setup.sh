#!/usr/bin/env bash
# Runs ON the RunPod pod, inside the `cs659` screen session launched by
# laptop_bootstrap.py. Owns the entire pod lifecycle synchronously:
#   1. Install system + Python deps
#   2. Download + unzip + flatten PlantNet-300K
#   3. Train (foreground in this same screen)
#   4. Hand off to pod_orchestrator.py for analysis + GitHub upload + self-terminate
#
# After this script returns, the pod_orchestrator has self-terminated the pod.
# The screen session ends naturally; the pod disappears within ~30s.
#
# Required env (exported by laptop_bootstrap.py via `env VAR=... screen ...`):
#   RUN_TAG          — tag for the GitHub Release (e.g. run-2026-05-03T19-22Z)
#   COLOR_CORRECT    — optional: none|gray_world|max_rgb (overrides JSON default)
# Loaded from /workspace/.env (SCP'd by bootstrap):
#   ANTHROPIC_API_KEY, RUNPOD_API_KEY, GITHUB_TOKEN
set -euo pipefail

WORKSPACE=/workspace
REPO_URL="https://github.com/patla001/vision-plant-agent-runpod.git"
DATA_ZIP="$WORKSPACE/plantnet_300K.zip"
DATA_DIR="$WORKSPACE/plantnet_300K"
FLAT_DIR="$WORKSPACE/plantnet_flat"
RESULTS_DIR="$WORKSPACE/results"
REPO_DIR="$WORKSPACE/cs659"
DONE_FILE="$WORKSPACE/DONE"
AGENTS_DIR="$WORKSPACE/agents"

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"; }

# Source .env so subsequent processes inherit ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.
if [ -f "$WORKSPACE/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$WORKSPACE/.env"
  set +a
  log ".env loaded ($(grep -c '^[A-Z_]\+=' "$WORKSPACE/.env" || true) vars)"
else
  log "WARNING: /workspace/.env not found — pod_orchestrator will fail."
fi

# RUN_TAG must be present — bootstrap should have exported it.
if [ -z "${RUN_TAG:-}" ]; then
  log "FATAL: RUN_TAG env var missing. Aborting."
  exit 1
fi
log "Run tag: $RUN_TAG"

# ── 0. Install required system tools ──────────────────────────────────────────
log "Installing system tools (rsync, wget, unzip, git) …"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync wget unzip git
# screen was installed by the bootstrap before we got here.

# ── 1. Download PlantNet-300K ──────────────────────────────────────────────────
log "Downloading PlantNet-300K (31.7 GB) …"
wget -q --show-progress \
  "https://zenodo.org/records/5645731/files/plantnet_300K.zip?download=1" \
  -O "$DATA_ZIP"

# ── 2. Unzip ───────────────────────────────────────────────────────────────────
log "Unzipping …"
cd "$WORKSPACE"
unzip -q "$DATA_ZIP"
rm -f "$DATA_ZIP"
log "Unzip complete — $(du -sh "$DATA_DIR" | cut -f1) on disk"

# ── 3. Clone repo (for training scripts that aren't SCP'd individually) ───────
log "Cloning repo …"
git clone --depth=1 "$REPO_URL" "$REPO_DIR"

# ── 4a. Install training Python deps ──────────────────────────────────────────
log "Installing training Python deps (TensorFlow + sklearn) …"
pip install -q -r "$REPO_DIR/DeepLearning-tensorFlowLite/requirements-tflite.txt"

# ── 4b. Install GPU-bundled TensorFlow extras (CuDNN, cuBLAS, etc.) ──────────
log "Installing tensorflow[and-cuda] extras …"
pip install -q --upgrade "tensorflow[and-cuda]"

# ── 4c. Install agent deps (anthropic + requests + python-dotenv) ─────────────
log "Installing agent Python deps …"
pip install -q -r "$WORKSPACE/agent-requirements.txt"

# ── 5. Flatten dataset using symlinks ─────────────────────────────────────────
log "Flattening dataset (symlinks) …"
mkdir -p "$FLAT_DIR"
python "$REPO_DIR/DeepLearning-tensorFlowLite/flatten_plantnet.py" \
  --source "$DATA_DIR/images" \
  --out    "$FLAT_DIR" \
  --splits train,val,test \
  --min-images 10
log "Flatten complete — $(ls "$FLAT_DIR" | wc -l) species classes"

# ── 6. Train (synchronous in this screen session) ─────────────────────────────
mkdir -p "$RESULTS_DIR"

CC_FLAG=""
if [ -n "${COLOR_CORRECT:-}" ]; then
  CC_FLAG="--color_correct $COLOR_CORRECT"
  log "Color correction override: $COLOR_CORRECT"
fi

log "Starting CNN training (foreground) …"
cd "$REPO_DIR/DeepLearning-tensorFlowLite"
python training_wrapper.py \
  --data_dir   "$FLAT_DIR" \
  --result_dir "$RESULTS_DIR" \
  --done_file  "$DONE_FILE" \
  $CC_FLAG \
  2>&1 | tee "$RESULTS_DIR/training.log"

log "Training finished. Handing off to pod_orchestrator.py …"

# ── 7. Pod orchestrator: analysis → GitHub Release → self-terminate ──────────
# Run from /workspace/agents so sibling imports (base_agent, analysis_agent,
# github_release_tool, runpod_api) all resolve via the same sys.path entries
# the script adds at startup.
cd "$AGENTS_DIR"
PYTHONPATH="$AGENTS_DIR:$WORKSPACE" python pod_orchestrator.py \
  --results_dir "$RESULTS_DIR" \
  --done_file   "$DONE_FILE" \
  --run_tag     "$RUN_TAG" \
  --repo_dir    "$REPO_DIR" \
  2>&1 | tee "$RESULTS_DIR/orchestrator.log"

log "pod_setup.sh complete. Pod should self-terminate momentarily."
