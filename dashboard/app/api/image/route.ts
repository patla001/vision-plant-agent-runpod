import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RESULTS_ROOT = path.resolve(process.cwd(), "..", "results");

// Whitelist for safe path components — alphanumerics, dashes, underscores, dots only.
// Rejects:  ../, /, \, null bytes, leading dots, anything outside this charset.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// PNG filenames we serve are always things like "test_confusion_matrix_normalized.png"
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const run  = searchParams.get("run");
  const file = searchParams.get("file");

  // Whitelist validation: reject anything that isn't a clean run-folder name + .png filename
  if (!run || !file || !SAFE_NAME.test(run) || !SAFE_FILE.test(file)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  // Build candidate paths and verify each resolves *inside* RESULTS_ROOT
  const candidates = [
    path.resolve(RESULTS_ROOT, run, "single_split", file),
    path.resolve(RESULTS_ROOT, run, file),
  ].filter((p) => isInside(p, RESULTS_ROOT));

  const imgPath = candidates.find((p) => fs.existsSync(p));
  if (!imgPath) return new NextResponse("Not found", { status: 404 });

  const buf = fs.readFileSync(imgPath);
  return new NextResponse(buf, {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
