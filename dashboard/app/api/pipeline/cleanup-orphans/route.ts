import { NextRequest, NextResponse } from "next/server";

const RUNPOD_GQL = "https://api.runpod.io/graphql";

async function terminatePod(podId: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${RUNPOD_GQL}?api_key=${apiKey}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query:     `mutation TerminatePod($podId: String!) { podTerminate(input: { podId: $podId }) }`,
        variables: { podId },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, error: `RunPod ${r.status}` };
    const body = await r.json();
    if (body.errors) return { ok: false, error: JSON.stringify(body.errors) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** POST { podIds: string[] } — terminates every listed pod via RunPod's
 *  podTerminate mutation. Returns per-pod result. Does NOT touch local
 *  pipeline_state.json (the caller may still want to keep tracking the
 *  current run). */
export async function POST(req: NextRequest) {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "RUNPOD_API_KEY not set" }, { status: 500 });
  }

  let body: { podIds?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const podIds = Array.isArray(body.podIds)
    ? body.podIds.filter((x): x is string => typeof x === "string")
    : [];

  if (podIds.length === 0) {
    return NextResponse.json({ error: "podIds must be a non-empty array of strings." }, { status: 400 });
  }

  const results: Record<string, { ok: boolean; error?: string }> = {};
  // Sequential — RunPod has occasionally rate-limited rapid mutations.
  for (const id of podIds) {
    results[id] = await terminatePod(id, apiKey);
  }

  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  return NextResponse.json({
    ok:           failed.length === 0,
    terminated:   Object.entries(results).filter(([, r]) => r.ok).map(([id]) => id),
    failed:       Object.fromEntries(failed),
  });
}
