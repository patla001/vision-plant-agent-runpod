import fs from "fs";
import path from "path";

const ROOT     = path.resolve(process.cwd(), "..");
const RESULTS  = path.join(ROOT, "results");
const LAST_RUN = path.join(RESULTS, "last_run.json");

// The outcome of the most recently observed run. This file is the durable
// record that survives /api/pipeline/reset (which deletes pipeline_state.json
// + pipeline.log but NOT this file), so the home page can always tell the
// user whether their last run produced saveable results.
//
// Outcomes:
//   completed_synced     — Release was published AND assets were downloaded
//   completed_unsynced   — Release exists but the user hasn't synced yet
//   partial_upload       — pod terminated mid-upload (draft Release, some assets only)
//   terminated_no_results — pod gone, no Release at all (the "lost run" case)
//   aborted_by_user      — user clicked Abort
//   failed_pre_pod       — laptop_bootstrap.py crashed before the pod ran
export type LastRunOutcome =
  | "completed_synced"
  | "completed_unsynced"
  | "partial_upload"
  | "terminated_no_results"
  | "aborted_by_user"
  | "failed_pre_pod";

export interface LastRunRecord {
  run_tag:        string;
  outcome:        LastRunOutcome;
  finished_at:    string;          // ISO timestamp
  pod_id?:        string;
  color_correct?: string;          // so the user can see what they last picked
  hp_mode?:       string;
  release_url?:   string;
  asset_count?:   number;          // for completed_synced
  message?:       string;          // human-readable detail (esp. for failed/aborted)
}

export function writeLastRun(rec: LastRunRecord): void {
  try {
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(LAST_RUN, JSON.stringify(rec, null, 2));
  } catch {
    // Non-fatal: the outcome file is informational; failing to write it
    // shouldn't break the calling endpoint's primary response.
  }
}

export function readLastRun(): LastRunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(LAST_RUN, "utf8")) as LastRunRecord;
  } catch {
    return null;
  }
}

export const LAST_RUN_PATH = LAST_RUN;
