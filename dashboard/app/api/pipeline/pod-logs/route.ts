import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

function tailFile(podIp: string, podPort: number, remotePath: string, lines = 80): { ok: boolean; content: string } {
  // Two non-obvious bits in this remote command:
  //   1. `[ -f path ]` precedes the pipe so a missing file always prints the
  //      fallback. Relying on `tail | tr || echo` doesn't work because tr
  //      exits 0 on empty stdin even when tail's input redirection fails.
  //   2. `tr '\r' '\n'` expands Keras / wget progress bars (which overwrite
  //      a single line via carriage returns) into bounded discrete lines so
  //      `tail -n` can actually limit the response size.
  const remoteCmd =
    `[ -f ${remotePath} ] && ` +
    `tr '\\r' '\\n' < ${remotePath} | tail -n ${lines} ` +
    `|| echo '[file not found: ${remotePath}]'`;

  const r = spawnSync("ssh", [
    "-T", "-n",
    "-p", String(podPort),
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=20",
    `root@${podIp}`,
    remoteCmd,
  ], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) {
    return { ok: false, content: ((r.stdout || "") + (r.stderr || "")).slice(-4000) };
  }
  // Hard-cap the response so a runaway log doesn't blow up the network.
  const out = (r.stdout || "").slice(-32_000);
  return { ok: true, content: out };
}

/** Pulls the last N lines of the pod's setup.log + orchestrator.log + screen
 *  session list. Used by the dashboard's "Fetch pod logs" button when the
 *  user suspects the pod is stuck. Read-only — never mutates state.  */
export async function GET() {
  const st = readState();
  const podIp   = typeof st.pod_ip   === "string" ? st.pod_ip   : null;
  const podPort = typeof st.pod_port === "number" ? st.pod_port : null;
  if (!podIp || !podPort) {
    return NextResponse.json({
      error: "No pod_ip/pod_port in pipeline_state.json — nothing to query.",
    }, { status: 409 });
  }

  // Quick screen-session check first. If it's gone but the pod is still
  // RUNNING, we're in the stuck state the user just hit.
  const screenLs = spawnSync("ssh", [
    "-T", "-n",
    "-p", String(podPort),
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=20",
    `root@${podIp}`,
    "screen -ls 2>&1 | head -20",
  ], { encoding: "utf8", timeout: 20_000 });

  const setupLog        = tailFile(podIp, podPort, "/workspace/setup.log",            120);
  const orchestratorLog = tailFile(podIp, podPort, "/workspace/results/orchestrator.log", 120);
  const trainingLogTail = tailFile(podIp, podPort, "/workspace/results/training.log", 30);

  return NextResponse.json({
    podIp,
    podPort,
    screenSessions: screenLs.status === 0
      ? (screenLs.stdout || "").trim()
      : `[ssh failed: ${(screenLs.stderr || "").trim().slice(-500)}]`,
    setupLog:        setupLog.content,
    orchestratorLog: orchestratorLog.content,
    trainingLogTail: trainingLogTail.content,
  });
}
