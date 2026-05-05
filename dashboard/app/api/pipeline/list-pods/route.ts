import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");

const RUNPOD_GQL = "https://api.runpod.io/graphql";

// Same dynamic-route fix as poll-pod — Next 14 caches GET handlers when it
// can't see dynamic inputs (we use fs.readFileSync), and a stale list of pods
// would mean the orphan-cleanup modal lies about what's actually running.
export const dynamic = "force-dynamic";

interface PodRow {
  id: string;
  name: string | null;
  desiredStatus: string | null;
  gpuDisplayName: string | null;
  uptimeSeconds: number | null;
  costPerHr: number | null;
  isCurrent: boolean;
}

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

/** Lists all pods on the user's RunPod account, marking which one is the
 *  pod currently tracked in pipeline_state.json. Used by the OrphanPodModal
 *  so the user can spot leftover pods from past botched runs.  */
export async function GET() {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "RUNPOD_API_KEY not set" }, { status: 500 });
  }

  const st       = readState();
  const currentId = typeof st.pod_id === "string" ? st.pod_id : null;

  try {
    const r = await fetch(`${RUNPOD_GQL}?api_key=${apiKey}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query {
            myself {
              pods {
                id
                name
                desiredStatus
                costPerHr
                runtime { uptimeInSeconds }
                machine { gpuDisplayName }
              }
            }
          }
        `,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return NextResponse.json({ error: `RunPod API ${r.status}` }, { status: 502 });
    }
    const body = await r.json();
    if (body.errors) {
      return NextResponse.json({ error: JSON.stringify(body.errors) }, { status: 502 });
    }
    const pods = body?.data?.myself?.pods || [];
    const rows: PodRow[] = pods.map((p: {
      id: string;
      name?: string | null;
      desiredStatus?: string | null;
      costPerHr?: number | null;
      runtime?: { uptimeInSeconds?: number | null } | null;
      machine?: { gpuDisplayName?: string | null } | null;
    }) => ({
      id:             p.id,
      name:           p.name ?? null,
      desiredStatus:  p.desiredStatus ?? null,
      costPerHr:      p.costPerHr ?? null,
      gpuDisplayName: p.machine?.gpuDisplayName ?? null,
      uptimeSeconds:  p.runtime?.uptimeInSeconds ?? null,
      isCurrent:      currentId === p.id,
    }));

    return NextResponse.json({ pods: rows, currentId });
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : String(e),
    }, { status: 502 });
  }
}
