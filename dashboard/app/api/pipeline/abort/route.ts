import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");

const RUNPOD_GQL = "https://api.runpod.io/graphql";

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

async function terminatePod(podId: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) return { ok: false, error: "RUNPOD_API_KEY not set" };

  try {
    const resp = await fetch(`${RUNPOD_GQL}?api_key=${apiKey}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        query:     `mutation TerminatePod($podId: String!) { podTerminate(input: { podId: $podId }) }`,
        variables: { podId },
      }),
      // Don't hang the abort UI for long
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { ok: false, error: `RunPod API ${resp.status}` };
    const body = await resp.json();
    if (body.errors) return { ok: false, error: JSON.stringify(body.errors) };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function killProcess(pid: number): { ok: boolean; error?: string } {
  try {
    process.kill(pid, "SIGTERM");
    return { ok: true };
  } catch (e: unknown) {
    // ESRCH = no such process (already dead — fine)
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: true };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function POST() {
  const st = readState();
  // "running" is the laptop-resident-orchestrator state; "running-on-pod" is
  // the detached pod-side state from PR #20. Both should accept abort —
  // otherwise the user has no dashboard path to kill a stuck pod-side run.
  if (st.status !== "running" && st.status !== "running-on-pod") {
    return NextResponse.json({ error: "No running pipeline to abort." }, { status: 409 });
  }

  const podId = typeof st.pod_id === "string" ? st.pod_id : null;
  const pid   = typeof st.pid    === "number" ? st.pid    : null;

  // Step 1: terminate the RunPod pod (most expensive thing first)
  let podResult: { ok: boolean; error?: string } = { ok: true };
  if (podId) {
    podResult = await terminatePod(podId);
  }

  // Step 2: kill the local Python orchestrator (it'll stop polling, no further API costs)
  let procResult: { ok: boolean; error?: string } = { ok: true };
  if (pid) {
    procResult = killProcess(pid);
  }

  // Step 3: write aborted state
  const aborted = {
    ...st,
    status:        "failed",
    current_step:  "Aborted by user",
    error_type:    "AbortRequested",
    error_message: "User clicked Abort. Pod terminated to stop billing.",
    finished_at:   new Date().toISOString(),
    aborted_at:    new Date().toISOString(),
    abort_pod_result:  podResult,
    abort_proc_result: procResult,
  };
  fs.writeFileSync(STATE, JSON.stringify(aborted, null, 2));

  return NextResponse.json({
    aborted: true,
    podTerminated:    podResult.ok,
    processKilled:    procResult.ok,
    podError:         podResult.error,
    processError:     procResult.error,
  });
}
