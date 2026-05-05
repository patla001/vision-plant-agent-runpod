import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RESULTS = path.resolve(process.cwd(), "..", "results");

// Hyperparameter keys the start route accepts as overrides. Mirrors
// ALLOWED_HP_KEYS in dashboard/app/api/pipeline/start/route.ts. A value
// outside this set is ignored on a manual upload — same posture the start
// route takes — so a typo or stray field can't sneak through into the run.
const ALLOWED_HP_KEYS = ["epochs", "learning_rate", "dropout", "early_stopping_patience"] as const;

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

/**
 * POST — accept a manually-supplied hyperparameter suggestion and persist
 * it as results/last_suggested_hyperparameters.json. The dashboard's
 * "AI suggested" picker reads from there, so a manual upload immediately
 * unblocks the next run.
 *
 * Body shape: { diagnosis?, reasoning?, suggested_hyperparameters: {...},
 *               expected_improvement?, based_on_run? }
 *
 * `suggested_hyperparameters` is required and gets sanitized — only the
 * four allowed keys (epochs, learning_rate, dropout, early_stopping_patience)
 * survive, matching the start route's ALLOWED_HP_KEYS.
 *
 * Use case: the previous pod run failed to ship the suggester JSON in its
 * Release. The user can either paste a snippet into the dashboard or upload
 * a JSON file pulled from a different source. Either way this endpoint
 * normalizes it into the same on-disk shape the pod-side suggester writes.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const raw = body.suggested_hyperparameters;
  if (raw === null || typeof raw !== "object") {
    return NextResponse.json({
      error: "Field `suggested_hyperparameters` (object) is required.",
    }, { status: 400 });
  }

  const sanitized: Record<string, number> = {};
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(ALLOWED_HP_KEYS as readonly string[]).includes(k)) {
      skipped.push(k);
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      sanitized[k] = v;
    } else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      sanitized[k] = Number(v);
    } else {
      skipped.push(k);
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return NextResponse.json({
      error: `No valid hyperparameters provided. Allowed keys: ${ALLOWED_HP_KEYS.join(", ")}.`,
      skipped,
    }, { status: 400 });
  }

  const record = {
    diagnosis:                 typeof body.diagnosis === "string"             ? body.diagnosis             : "manual_upload",
    reasoning:                 typeof body.reasoning === "string"             ? body.reasoning             : "Uploaded manually via dashboard.",
    suggested_hyperparameters: sanitized,
    expected_improvement:      typeof body.expected_improvement === "string"  ? body.expected_improvement  : "n/a (manual override)",
    based_on_run:              typeof body.based_on_run === "string"          ? body.based_on_run          : null,
    produced_at:               new Date().toISOString(),
    current_hyperparameters:   {},
    _manual_upload:            true,
  };

  fs.mkdirSync(RESULTS, { recursive: true });
  const dest = path.join(RESULTS, "last_suggested_hyperparameters.json");
  fs.writeFileSync(dest, JSON.stringify(record, null, 2) + "\n");

  return NextResponse.json({
    ok:          true,
    saved_to:    path.relative(path.resolve(process.cwd(), ".."), dest),
    accepted:    Object.keys(sanitized),
    skipped,
    record,
  });
}
