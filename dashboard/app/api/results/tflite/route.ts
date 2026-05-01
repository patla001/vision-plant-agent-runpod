import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RESULTS = path.resolve(process.cwd(), "..", "results");
const TFLITE  = path.join(RESULTS, "plant_classifier_deep_learning.tflite");

// HEAD request: lets the dashboard probe whether the file exists without
// downloading it (used to enable/disable the button).
export async function HEAD() {
  if (!fs.existsSync(TFLITE)) {
    return new NextResponse(null, { status: 404 });
  }
  const stat = fs.statSync(TFLITE);
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Content-Type":   "application/octet-stream",
      "Content-Length": String(stat.size),
    },
  });
}

export async function GET() {
  if (!fs.existsSync(TFLITE)) {
    return NextResponse.json(
      { error: "TFLite model not found. Either training has not completed or the artifact was not produced." },
      { status: 404 },
    );
  }
  const data = fs.readFileSync(TFLITE);
  // Use a Uint8Array view so NextResponse's BodyInit is satisfied without
  // copying. Buffer is a Node-only Uint8Array subclass.
  return new NextResponse(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
    status: 200,
    headers: {
      "Content-Type":        "application/octet-stream",
      "Content-Disposition": 'attachment; filename="plant_classifier_deep_learning.tflite"',
      "Content-Length":      String(data.byteLength),
    },
  });
}
