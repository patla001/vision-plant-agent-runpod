import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const LOG     = path.join(RESULTS, "pipeline.log");

function lastLines(filePath: string, n: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter(Boolean);
  return lines.slice(-n);
}

function hasResults(): boolean {
  if (!fs.existsSync(RESULTS)) return false;
  return fs.readdirSync(RESULTS).some((d) => {
    const full = path.join(RESULTS, d);
    return fs.statSync(full).isDirectory() && /^\d{4}-\d{2}-\d{2}/.test(d);
  });
}

export async function GET() {
  let state: Record<string, unknown> = { status: "idle" };
  if (fs.existsSync(STATE)) {
    try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { /* use idle */ }
  }

  const logLines = lastLines(LOG, 100);

  return NextResponse.json({
    ...state,
    logLines,
    hasResults: hasResults(),
  });
}
