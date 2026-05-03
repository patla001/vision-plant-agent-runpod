import { NextRequest, NextResponse } from "next/server";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const SCRIPTS = path.join(ROOT, "scripts");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const LOG     = path.join(RESULTS, "pipeline.log");

// Must match VALID_COLOR_CORRECT in scripts/agents/run_pipeline.py
const VALID_COLOR_CORRECT = ["none", "gray_world", "max_rgb"] as const;
type ColorCorrect = typeof VALID_COLOR_CORRECT[number];

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

/**
 * Resolve which Python binary to use:
 *   1. PYTHON_BIN env var if set (deployment override)
 *   2. python3 (modern macOS / Linux default)
 *   3. python (fallback for systems where it's symlinked to python3)
 *
 * Returns null if neither is found.
 */
function resolvePython(): string | null {
  const explicit = process.env.PYTHON_BIN;
  if (explicit) return explicit;

  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

// Hyperparameter fields the dashboard is allowed to override per-run.
// The full schema is defined in DeepLearning-tensorFlowLite/model_hyperparameters.json
// under deep_learning; we accept the four most-tunable values + ignore the rest
// so a typo in the UI doesn't silently break training.
const ALLOWED_HP_KEYS = ["epochs", "learning_rate", "dropout", "early_stopping_patience"] as const;

function sanitizeHyperparameters(raw: unknown): Record<string, number> | null {
  if (raw === null || typeof raw !== "object") return null;
  const out: Record<string, number> = {};
  for (const k of ALLOWED_HP_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function POST(req: NextRequest) {
  // Optional body: {
  //   color_correct?: "none" | "gray_world" | "max_rgb",
  //   hyperparameters?: { epochs?, learning_rate?, dropout?, early_stopping_patience? }
  // }
  // Anything else falls back to model_hyperparameters.json's defaults.
  let colorCorrect:    ColorCorrect | null = null;
  let hyperparameters: Record<string, number> | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    const raw = typeof body?.color_correct === "string" ? body.color_correct : "";
    if (raw) {
      if (!(VALID_COLOR_CORRECT as readonly string[]).includes(raw)) {
        return NextResponse.json({
          error: `color_correct must be one of ${VALID_COLOR_CORRECT.join(", ")}.`,
        }, { status: 400 });
      }
      colorCorrect = raw as ColorCorrect;
    }
    hyperparameters = sanitizeHyperparameters(body?.hyperparameters);
  } catch { /* no body — fine */ }

  // Verify Python is callable before doing anything else
  const pythonBin = resolvePython();
  if (!pythonBin) {
    return NextResponse.json({
      error: "Python interpreter not found. Install Python 3 or set PYTHON_BIN env var to its absolute path.",
    }, { status: 500 });
  }

  // Reject if already running
  if (fs.existsSync(STATE)) {
    const st = readState();
    if (st.status === "running" && typeof st.pid === "number" && isAlive(st.pid)) {
      return NextResponse.json({ error: "Pipeline already running." }, { status: 409 });
    }
  }

  // Ensure results dir exists and open log file
  fs.mkdirSync(RESULTS, { recursive: true });
  const logFd = fs.openSync(LOG, "a");

  // Spawn Python pipeline as a fully detached background process.
  //
  // PYTHONDONTWRITEBYTECODE=1 prevents Python from writing __pycache__ .pyc
  // files. Without this, stale .pyc from a previous git branch (e.g. when
  // PR #5's _constants module was tested locally) can override fresh .py
  // sources after a git pull. The mtime-based recompilation check is not
  // 100% reliable, especially when git restores files with old timestamps.
  // PYTHONUNBUFFERED=1 ensures stdout flushes immediately so the dashboard
  // sees log lines in real time instead of after process exit.
  // laptop_bootstrap.py provisions the pod, SCPs code + secrets, and starts
  // the pod-side orchestrator inside a screen session. After it exits, the
  // pod runs autonomously — laptop can disconnect entirely.
  const child = spawn(pythonBin, ["agents/laptop_bootstrap.py"], {
    cwd: SCRIPTS,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED:        "1",
      ...(colorCorrect    ? { PIPELINE_COLOR_CORRECT: colorCorrect }                   : {}),
      ...(hyperparameters ? { PIPELINE_HYPERPARAMETERS: JSON.stringify(hyperparameters) } : {}),
    },
  });
  child.unref();
  fs.closeSync(logFd);

  // Write initial state (Python will overwrite with pid from its own process)
  const initial = {
    status: "running",
    current_step: "Starting pipeline...",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: null,
    pid: child.pid,
    python_bin: pythonBin,
    color_correct: colorCorrect ?? "default",
  };
  fs.writeFileSync(STATE, JSON.stringify(initial, null, 2));

  return NextResponse.json({ started: true, pid: child.pid, python: pythonBin, color_correct: colorCorrect });
}
