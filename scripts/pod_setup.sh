#!/usr/bin/env bash
# Runs ON the RunPod pod (uploaded and executed by launch.py).
# Downloads PlantNet-300K, sets up the repo, flattens the dataset,
# then launches the CNN training inside a detached screen session.
set -euo pipefail

WORKSPACE=/workspace
REPO_URL="https://github.com/Mason-Leavitt/CS659_Project.git"
DATA_ZIP="$WORKSPACE/plantnet_300K.zip"
DATA_DIR="$WORKSPACE/plantnet_300K"
FLAT_DIR="$WORKSPACE/plantnet_flat"
RESULTS_DIR="$WORKSPACE/results"
REPO_DIR="$WORKSPACE/cs659"
DONE_FILE="$WORKSPACE/DONE"

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"; }

# ── 1. Download PlantNet-300K ──────────────────────────────────────────────────
log "Downloading PlantNet-300K (31.7 GB) …"
wget -q --show-progress \
  "https://zenodo.org/records/5645731/files/plantnet_300K.zip?download=1" \
  -O "$DATA_ZIP"

# ── 2. Unzip ───────────────────────────────────────────────────────────────────
log "Unzipping …"
cd "$WORKSPACE"
unzip -q "$DATA_ZIP"
rm -f "$DATA_ZIP"   # free 32 GB immediately after extraction
log "Unzip complete — $(du -sh "$DATA_DIR" | cut -f1) on disk"

# ── 3. Clone repo ─────────────────────────────────────────────────────────────
log "Cloning repo …"
git clone --depth=1 "$REPO_URL" "$REPO_DIR"

# ── 4. Install Python deps ────────────────────────────────────────────────────
log "Installing Python dependencies …"
pip install -q -r "$REPO_DIR/DeepLearning-tensorFlowLite/requirements-tflite.txt"

# ── 5. Flatten dataset using symlinks (saves ~35 GB vs. copies) ───────────────
log "Flattening dataset (symlinks) …"
mkdir -p "$FLAT_DIR"
python "$REPO_DIR/DeepLearning-tensorFlowLite/flatten_plantnet.py" \
  --source "$DATA_DIR/images" \
  --out    "$FLAT_DIR" \
  --splits train,val,test \
  --min-images 10   # drop classes with <10 total images

log "Flatten complete — $(ls "$FLAT_DIR" | wc -l) species classes"

# ── 6. Launch CNN training in a detached screen session ───────────────────────
mkdir -p "$RESULTS_DIR"
log "Starting CNN training in screen session 'train_cnn' …"

screen -dmS train_cnn bash -c "
  cd $REPO_DIR/DeepLearning-tensorFlowLite
  python training_wrapper.py \
    --data_dir $FLAT_DIR \
    --result_dir $RESULTS_DIR \
    --done_file $DONE_FILE \
    2>&1 | tee $RESULTS_DIR/training.log
"

log "Screen session started. Monitor with: screen -r train_cnn"
log "Training log: $RESULTS_DIR/training.log"
