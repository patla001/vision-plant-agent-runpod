import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import Papa from "papaparse";

// results/ lives one level above dashboard/
const RESULTS_ROOT = path.resolve(process.cwd(), "..", "results");

function latestRun(): string | null {
  if (!fs.existsSync(RESULTS_ROOT)) return null;
  const dirs = fs.readdirSync(RESULTS_ROOT)
    .filter((d) => fs.statSync(path.join(RESULTS_ROOT, d)).isDirectory())
    .sort()
    .reverse();
  return dirs[0] ?? null;
}

function readJson(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function readText(p: string): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

// Cache parsed CSV by file path + mtime. The dashboard hits this endpoint
// every time the user lands on the results page, but the CSV only changes
// once per training run. Re-parsing tens of KB on every navigation is wasteful.
const _csvCache = new Map<string, { mtimeMs: number; rows: Record<string, string>[] }>();

function parseCsv(p: string): Record<string, string>[] {
  try {
    const stat   = fs.statSync(p);
    const cached = _csvCache.get(p);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.rows;

    const text   = fs.readFileSync(p, "utf8");
    const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    _csvCache.set(p, { mtimeMs: stat.mtimeMs, rows: result.data });
    return result.data;
  } catch { return []; }
}

function findPngs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort();
}

export async function GET() {
  const run = latestRun();
  if (!run) {
    return NextResponse.json({ error: "No results found. Run training first." }, { status: 404 });
  }

  // A run may have a single_split/ subfolder or fold_*/ subfolders
  const runDir  = path.join(RESULTS_ROOT, run);
  const splitDir = path.join(runDir, "single_split");
  const activeDir = fs.existsSync(splitDir) ? splitDir : runDir;

  const hyperparams  = readJson(path.join(runDir, "hyperparameters_snapshot.json"));
  const splitSummary = readJson(path.join(runDir, "split_summary.json"));
  const csvRows      = parseCsv(path.join(activeDir, "metrics_train_val_test.csv"));
  const pngs         = findPngs(activeDir);
  const classReport  = readText(path.join(activeDir, "test_classification_report.txt"));

  return NextResponse.json({
    run,
    hyperparams,
    splitSummary,
    csvRows,
    pngs,          // filenames only; served via /api/image?run=...&file=...
    classReport,
  });
}
