import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");

const RUNPOD_GQL = "https://api.runpod.io/graphql";

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

async function podIsAlive(podId: string, apiKey: string): Promise<boolean> {
  try {
    const r = await fetch(`${RUNPOD_GQL}?api_key=${apiKey}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query:     `query Pod($id: String!) { pod(input: { podId: $id }) { id desiredStatus } }`,
        variables: { id: podId },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return false;
    const body = await r.json();
    return body?.data?.pod?.desiredStatus === "RUNNING";
  } catch {
    return false;
  }
}

/** POST — restart training on the pod that's already tracked in
 *  pipeline_state.json. Skips dataset re-download because pod_setup.sh
 *  was made idempotent. Used by the failed-state "Restart training on
 *  same pod" button when the pod is verifiably alive. */
export async function POST() {
  const st = readState();
  const podId  = typeof st.pod_id   === "string" ? st.pod_id   : null;
  const podIp  = typeof st.pod_ip   === "string" ? st.pod_ip   : null;
  const podPort = typeof st.pod_port === "number" ? st.pod_port : null;
  const colorCorrect = typeof st.color_correct === "string" && st.color_correct !== "default"
    ? st.color_correct
    : "";

  if (!podId || !podIp || !podPort) {
    return NextResponse.json({
      error: "No pod tracked in pipeline_state.json. Use Fresh start to provision a new pod.",
    }, { status: 409 });
  }

  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "RUNPOD_API_KEY not set" }, { status: 500 });
  }
  if (!(await podIsAlive(podId, apiKey))) {
    return NextResponse.json({
      error: `Pod ${podId} is not RUNNING. Use Fresh start instead.`,
    }, { status: 409 });
  }

  // New run_tag (UTC, second precision; same format as laptop_bootstrap.py).
  const newRunTag = "run-" + new Date().toISOString().replace(/:/g, "-").replace(/\.\d+/, "").replace(/Z$/, "Z");

  // Single SSH command:
  //   1. kill stale screen
  //   2. clear DONE + prior results + setup.log
  //   3. start fresh screen running pod_setup.sh with new RUN_TAG
  //
  // pod_setup.sh is idempotent (added in this PR) so wget/unzip/flatten
  // skip when their outputs already exist on disk. `-L -Logfile` tells
  // screen to mirror its pty output to setup.log so the dashboard's
  // pod-logs route can tail live progress (the outer redirect only
  // catches screen's startup errors).
  const ccExport = colorCorrect ? `COLOR_CORRECT=${colorCorrect} ` : "";
  const remoteCmd = [
    "set -e",
    "screen -S cs659 -X quit 2>/dev/null || true",
    "rm -f /workspace/DONE",
    "rm -rf /workspace/results/* 2>/dev/null || true",
    "rm -f /workspace/setup.log",
    "chmod +x /workspace/pod_setup.sh",
    `( setsid env RUN_TAG=${newRunTag} ${ccExport}` +
      "  screen -dmS cs659 -L -Logfile /workspace/setup.log " +
      "  bash /workspace/pod_setup.sh " +
      "  > /dev/null 2>&1 < /dev/null )",
    "sleep 2",
    "screen -ls | grep cs659 || (echo SCREEN_NOT_RUNNING; exit 1)",
  ].join(" && ");

  const ssh = spawnSync("ssh", [
    "-T", "-n",
    "-p", String(podPort),
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=20",
    `root@${podIp}`,
    remoteCmd,
  ], { encoding: "utf8", timeout: 60_000 });

  if (ssh.status !== 0) {
    const out = ((ssh.stdout || "") + (ssh.stderr || "")).slice(-2000);
    return NextResponse.json({
      error: "SSH command failed.",
      detail: out,
    }, { status: 502 });
  }
  if (!ssh.stdout?.includes("cs659")) {
    return NextResponse.json({
      error: "Screen session did not appear after launch.",
      detail: (ssh.stdout || "") + (ssh.stderr || ""),
    }, { status: 502 });
  }

  // Update local state — drop error fields, set new run_tag, status back to running-on-pod.
  const updated = {
    ...st,
    status:        "running-on-pod",
    current_step:  `Restarted training on pod ${podId} (run tag ${newRunTag})`,
    started_at:    new Date().toISOString(),
    finished_at:   null,
    updated_at:    new Date().toISOString(),
    run_tag:       newRunTag,
    error_type:    undefined,
    error_message: undefined,
    error_traceback: undefined,
  };
  // JSON.stringify drops undefined fields naturally — that's the cleanup we want.
  fs.writeFileSync(STATE, JSON.stringify(updated, null, 2));

  return NextResponse.json({ ok: true, podId, newRunTag });
}
