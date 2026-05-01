import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const LOG     = path.join(RESULTS, "pipeline.log");

/**
 * Delete the pipeline_state.json and pipeline.log files so the dashboard
 * returns to its idle state. Used by the "Start Over" button after a
 * failed run that left status="done" with no actual results.
 *
 * Note: this does NOT touch any timestamped run directories under results/
 * — only the two top-level housekeeping files.
 */
export async function POST() {
  let stateRemoved = false;
  let logRemoved   = false;

  try { fs.unlinkSync(STATE); stateRemoved = true; } catch { /* may not exist */ }
  try { fs.unlinkSync(LOG);   logRemoved   = true; } catch { /* may not exist */ }

  return NextResponse.json({ ok: true, stateRemoved, logRemoved });
}
