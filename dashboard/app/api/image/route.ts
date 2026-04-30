import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RESULTS_ROOT = path.resolve(process.cwd(), "..", "results");

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const run  = searchParams.get("run");
  const file = searchParams.get("file");

  if (!run || !file || file.includes("..")) {
    return new NextResponse("Bad request", { status: 400 });
  }

  // Check both single_split/ and the run root
  const candidates = [
    path.join(RESULTS_ROOT, run, "single_split", file),
    path.join(RESULTS_ROOT, run, file),
  ];

  const imgPath = candidates.find((p) => fs.existsSync(p));
  if (!imgPath) return new NextResponse("Not found", { status: 404 });

  const buf = fs.readFileSync(imgPath);
  return new NextResponse(buf, {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
