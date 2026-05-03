import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RESULTS = path.resolve(process.cwd(), "..", "results");

/** Returns the most recent AI hyperparameter suggestion, or 404 if none exists.
 *
 * Resolution order:
 *   1. results/last_suggested_hyperparameters.json (top-level convenience copy)
 *   2. results/<latest run dir>/suggested_hyperparameters.json
 *
 * The pod-side hyperparameter_suggester writes the file into results_dir on
 * the pod; sync-release downloads it as part of the Release assets and ALSO
 * copies it to the top-level location for fast lookup.
 */
function findLatestSuggestion(): { path: string; runTag: string | null } | null {
  const topLevel = path.join(RESULTS, "last_suggested_hyperparameters.json");
  if (fs.existsSync(topLevel)) {
    return { path: topLevel, runTag: null };
  }
  if (!fs.existsSync(RESULTS)) return null;
  const candidates = fs.readdirSync(RESULTS)
    .filter((d) => {
      const full = path.join(RESULTS, d);
      try { return fs.statSync(full).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse();
  for (const dir of candidates) {
    const p = path.join(RESULTS, dir, "suggested_hyperparameters.json");
    if (fs.existsSync(p)) return { path: p, runTag: dir };
  }
  return null;
}

export async function GET() {
  const found = findLatestSuggestion();
  if (!found) {
    return NextResponse.json({
      error: "No AI hyperparameter suggestion found. Run a training first.",
    }, { status: 404 });
  }
  try {
    const body = JSON.parse(fs.readFileSync(found.path, "utf8"));
    return NextResponse.json({
      ...body,
      _source_path: path.relative(path.resolve(process.cwd(), ".."), found.path),
      _from_run:    body.based_on_run ?? found.runTag,
    });
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
