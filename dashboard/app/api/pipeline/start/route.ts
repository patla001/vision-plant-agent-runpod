import { NextResponse } from "next/server";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const SCRIPTS = path.join(ROOT, "scripts");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const LOG     = path.join(RESULTS, "pipeline.log");

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

export async function POST() {
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

  // Spawn Python pipeline as a fully detached background process
  const child = spawn(pythonBin, ["agents/run_pipeline.py"], {
    cwd: SCRIPTS,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
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
  };
  fs.writeFileSync(STATE, JSON.stringify(initial, null, 2));

  return NextResponse.json({ started: true, pid: child.pid, python: pythonBin });
}
