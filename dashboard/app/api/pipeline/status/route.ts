import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const LOG     = path.join(RESULTS, "pipeline.log");

interface Issue {
  type: "error" | "warning";
  lineNumber: number;
  text: string;
  context: string[];   // up to 3 lines after for traceback continuation
}

const ERROR_RE   = /\b(ERROR|Error|Traceback \(most recent call last\)|Exception|FAILED|failed)\b/;
const WARNING_RE = /\b(WARN|WARNING|Warning|warning)\b/;
const CONTEXT_LINES = 3;

function lastLines(filePath: string, n: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter(Boolean);
  return lines.slice(-n);
}

function readAllLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n");
}

function findIssues(allLines: string[]): { errors: Issue[]; warnings: Issue[] } {
  const errors:   Issue[] = [];
  const warnings: Issue[] = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line) continue;

    const isError = ERROR_RE.test(line);
    const isWarn  = !isError && WARNING_RE.test(line);
    if (!isError && !isWarn) continue;

    const context = allLines.slice(i + 1, i + 1 + CONTEXT_LINES).filter(Boolean);
    const issue: Issue = { type: isError ? "error" : "warning", lineNumber: i + 1, text: line, context };
    if (isError) errors.push(issue);
    else         warnings.push(issue);
  }

  // Cap to avoid sending huge payloads — keep most recent 30 of each
  return {
    errors:   errors.slice(-30),
    warnings: warnings.slice(-30),
  };
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
    try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { /* idle */ }
  }

  const logLines = lastLines(LOG, 100);
  const { errors, warnings } = findIssues(readAllLines(LOG));

  return NextResponse.json({
    ...state,
    logLines,
    errors,
    warnings,
    errorCount:   errors.length,
    warningCount: warnings.length,
    hasResults:   hasResults(),
  });
}
