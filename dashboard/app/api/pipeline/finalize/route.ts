import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { writeLastRun, type LastRunOutcome } from "../../../../lib/last-run";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

const VALID_OUTCOMES: ReadonlySet<LastRunOutcome> = new Set([
  "completed_synced",
  "completed_unsynced",
  "partial_upload",
  "terminated_no_results",
  "aborted_by_user",
  "failed_pre_pod",
]);

/**
 * POST /api/pipeline/finalize — called by the dashboard when it observes a
 * definitive end-state for the current run that the server-side routes don't
 * naturally capture. Right now that's the pod-terminated banner: poll-pod
 * confirms the pod is gone with no Release, and the user clicks "Return to
 * home" — we record the outcome before reset wipes pipeline_state.json so
 * the home-page last-run card has something durable to display.
 *
 * Body:
 *   { outcome: "terminated_no_results" | "partial_upload" | "completed_unsynced" | ..., message?: string }
 *
 * The handler intentionally does NOT delete pipeline_state.json — the caller
 * pairs this with /api/pipeline/reset for that.
 */
export async function POST(req: NextRequest) {
  const st = readState();
  const runTag = typeof st.run_tag === "string" ? st.run_tag : null;
  if (!runTag) {
    return NextResponse.json({
      error: "No run_tag in pipeline_state.json — nothing to finalize.",
    }, { status: 400 });
  }

  let outcome: LastRunOutcome;
  let message: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (!VALID_OUTCOMES.has(body?.outcome)) {
      return NextResponse.json({
        error: `outcome must be one of: ${[...VALID_OUTCOMES].join(", ")}`,
      }, { status: 400 });
    }
    outcome = body.outcome as LastRunOutcome;
    message = typeof body.message === "string" ? body.message : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  writeLastRun({
    run_tag:       runTag,
    outcome,
    finished_at:   new Date().toISOString(),
    pod_id:        typeof st.pod_id === "string" ? st.pod_id : undefined,
    color_correct: typeof st.color_correct === "string" ? st.color_correct : undefined,
    hp_mode:       typeof st.hp_mode === "string" ? st.hp_mode : undefined,
    release_url:   typeof st.release_url === "string" ? st.release_url : undefined,
    message,
  });

  return NextResponse.json({ ok: true, run_tag: runTag, outcome });
}
