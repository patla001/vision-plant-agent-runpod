import { NextResponse } from "next/server";
import { readLastRun } from "../../../../lib/last-run";

/**
 * GET /api/pipeline/last-run — return the durable outcome record of the most
 * recent run, or null if none has been observed yet. Read by the home-page
 * card so the user knows whether the previous run produced saved results.
 *
 * Distinct from /api/pipeline/status (which describes the *currently active*
 * run from pipeline_state.json). last-run survives /api/pipeline/reset and
 * persists across new starts.
 */
export async function GET() {
  return NextResponse.json(readLastRun());
}
