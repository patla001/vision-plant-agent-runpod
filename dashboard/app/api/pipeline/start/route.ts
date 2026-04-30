import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const SCRIPTS  = path.join(ROOT, "scripts");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const LOG     = path.join(RESULTS, "pipeline.log");

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

export async function POST() {
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
  const child = spawn("python", ["agents/run_pipeline.py"], {
    cwd: SCRIPTS,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  fs.closeSync(logFd);

  // Write a fully-clean initial state. Explicitly null out any field that may
  // have been left over from a previous failed/done/aborted run, so the
  // dashboard never shows stale info during the brief window before Python's
  // first write_state() call.
  const initial = {
    status:        "running",
    current_step:  "Starting pipeline...",
    started_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
    finished_at:   null,
    pid:           child.pid,
    // ── Explicitly cleared from any previous run ──────────────
    error_type:        null,
    error_message:     null,
    error_traceback:   null,
    summary:           null,
    aborted_at:        null,
    abort_pod_result:  null,
    abort_proc_result: null,
    pod_id:            null,
    pod_ip:            null,
    pod_port:          null,
  };
  fs.writeFileSync(STATE, JSON.stringify(initial, null, 2));

  return NextResponse.json({ started: true, pid: child.pid });
}
