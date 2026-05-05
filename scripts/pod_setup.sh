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

# ── Safety-net self-terminate ────────────────────────────────────────────────
# Registered as an EXIT trap below so it fires on every exit path:
#   - normal completion (orchestrator self_terminate already ran; this is a no-op)
#   - `set -e` abort (e.g. apt-get / pip / training crashes mid-stream)
#   - pipefail-induced exit
# Without the trap, any failure before the orchestrator block would orphan the
# pod (script aborts before reaching the bottom-of-file terminate block) — a
# real-world bug we hit on the run that produced the 7h-stuck pod.
self_terminate_safety_net() {
  local rc=$?
  log "EXIT trap fired (script exit code $rc) — ensuring pod terminates."
  python - <<'PYEOF' || log "Final terminate failed; check RunPod dashboard."
import os, sys
sys.path.insert(0, "/workspace")
sys.path.insert(0, "/workspace/agents")
try:
    import runpod_api
    pod_id = os.environ.get("RUNPOD_POD_ID")
    if not pod_id:
        print("RUNPOD_POD_ID env var missing — cannot self-terminate.", file=sys.stderr)
        sys.exit(2)
    runpod_api.terminate_pod(pod_id)
    print(f"Pod {pod_id} terminate request sent.")
except Exception as exc:
    print(f"Final terminate raised: {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(3)
PYEOF
  return $rc
}
trap self_terminate_safety_net EXIT

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

# ── 0b. Bump sshd connection limits ───────────────────────────────────────────
# Default sshd MaxStartups is 10:30:60 — once 10 unauthenticated connections
# are in flight, sshd starts dropping new ones with "kex_exchange_identification:
# Connection reset by peer". The dashboard's pod-logs endpoint fanning out
# multiple SSH calls + the user attaching their own terminal hits this every
# time. Drop a config snippet that bumps the cap and reload sshd. Idempotent
# (we overwrite the same file every run).
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-cs659.conf
if [ -d /etc/ssh/sshd_config.d ]; then
  cat > "$SSHD_DROPIN" <<'EOF'
# Raised by CS659 pod_setup.sh — multi-connection dashboard polling otherwise
# trips sshd's MaxStartups throttle and locks the user out mid-training.
MaxStartups 100:30:200
MaxSessions 50
EOF
  # Reload sshd if it's running. service/systemctl both exist on RunPod images;
  # we try systemctl first and fall back. Failure is non-fatal — old limits
  # still beat killing the pod.
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ssh 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl restart ssh 2>/dev/null || true
  elif command -v service >/dev/null 2>&1; then
    service ssh reload 2>/dev/null || service ssh restart 2>/dev/null || true
  fi
  log "sshd MaxStartups raised to 100:30:200 (drop-in: $SSHD_DROPIN)"
else
  log "WARNING: /etc/ssh/sshd_config.d not present — leaving sshd defaults (connection resets likely under load)"
fi

# ── 1+2. Download + unzip PlantNet-300K (idempotent) ──────────────────────────
# Skipped on restart-training when the dataset directory is already present.
# Saves ~15 minutes of wget when the user clicks "Restart training on same pod".
if [ ! -d "$DATA_DIR" ]; then
  log "Downloading PlantNet-300K (31.7 GB) …"
  wget -q --show-progress \
    "https://zenodo.org/records/5645731/files/plantnet_300K.zip?download=1" \
    -O "$DATA_ZIP"
  log "Unzipping …"
  cd "$WORKSPACE"
  unzip -q "$DATA_ZIP"
  rm -f "$DATA_ZIP"
  log "Unzip complete — $(du -sh "$DATA_DIR" | cut -f1) on disk"
else
  log "Dataset already at $DATA_DIR ($(du -sh "$DATA_DIR" | cut -f1)) — skipping download/unzip"
fi

# ── 3. Clone repo (idempotent — pull if already cloned) ──────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
  log "Cloning repo …"
  git clone --depth=1 "$REPO_URL" "$REPO_DIR"
else
  log "Repo already cloned — pulling latest"
  git -C "$REPO_DIR" pull --ff-only --quiet || log "git pull failed (using existing tree)"
fi

# ── 4a. Install training Python deps ──────────────────────────────────────────
log "Installing training Python deps (TensorFlow + sklearn) …"
pip install -q -r "$REPO_DIR/DeepLearning-tensorFlowLite/requirements-tflite.txt"

# ── 4b. Install GPU-bundled TensorFlow extras (CuDNN, cuBLAS, etc.) ──────────
log "Installing tensorflow[and-cuda] extras …"
pip install -q --upgrade "tensorflow[and-cuda]"

# ── 4c. Install agent deps (anthropic + requests + python-dotenv) ─────────────
log "Installing agent Python deps …"
pip install -q -r "$WORKSPACE/agent-requirements.txt"

# ── 5. Flatten dataset using symlinks (idempotent) ───────────────────────────
if [ ! -d "$FLAT_DIR" ] || [ -z "$(ls -A "$FLAT_DIR" 2>/dev/null)" ]; then
  log "Flattening dataset (symlinks) …"
  mkdir -p "$FLAT_DIR"
  python "$REPO_DIR/DeepLearning-tensorFlowLite/flatten_plantnet.py" \
    --source "$DATA_DIR/images" \
    --out    "$FLAT_DIR" \
    --splits train,val,test \
    --min-images 10
  log "Flatten complete — $(ls "$FLAT_DIR" | wc -l) species classes"
else
  log "Flatten already done at $FLAT_DIR ($(ls "$FLAT_DIR" | wc -l) classes) — skipping"
fi

# ── 5b. Apply hyperparameter override (if user picked AI suggestion / manual) ──
# laptop_bootstrap.py SCPs a fully-merged model_hyperparameters.json here when
# the user overrides defaults via the dashboard's home-page picker. We replace
# the cloned repo's copy so train_export_tflite.py reads the override values.
HP_OVERRIDE="$WORKSPACE/hyperparameters_override.json"
HP_TARGET="$REPO_DIR/DeepLearning-tensorFlowLite/model_hyperparameters.json"
if [ -f "$HP_OVERRIDE" ]; then
  log "Applying hyperparameter override from $HP_OVERRIDE"
  cp "$HP_OVERRIDE" "$HP_TARGET"
else
  log "No hyperparameter override — using defaults from cloned repo"
fi

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
#
# `|| true` lets a non-zero orchestrator exit fall through to the final
# safety-net terminate below, so a stuck/crashed orchestrator never leaves
# the pod billing forever.
cd "$AGENTS_DIR"
PYTHONPATH="$AGENTS_DIR:$WORKSPACE" python pod_orchestrator.py \
  --results_dir "$RESULTS_DIR" \
  --done_file   "$DONE_FILE" \
  --run_tag     "$RUN_TAG" \
  --repo_dir    "$REPO_DIR" \
  2>&1 | tee "$RESULTS_DIR/orchestrator.log" || true

log "pod_setup.sh complete. The EXIT trap will issue the final terminate. "
log "Pod should disappear within ~30 seconds."
