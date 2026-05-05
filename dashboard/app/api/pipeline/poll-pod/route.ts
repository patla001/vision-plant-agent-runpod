import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const GIT_CFG = path.join(ROOT, ".git", "config");

const RUNPOD_GQL = "https://api.runpod.io/graphql";
const GH_API     = "https://api.github.com";

// Force the route handler to run on every request. Without this, Next 14
// caches the response when it can't see dynamic inputs (we read state via
// fs.readFileSync which Next doesn't track), so the dashboard kept showing
// alive:true on a pod that had been gone for hours.
export const dynamic = "force-dynamic";

// Combined status of a pod-side run. The dashboard uses this to render the
// reattach view when the user comes back hours later.
//
//   bootstrapping  — pod_id not yet recorded; bootstrap script still running
//   training       — pod is up, no Release yet
//   uploading      — pod is up AND draft Release exists (orchestrator is uploading)
//   partial        — pod gone, draft Release exists (orchestrator died mid-upload —
//                     some assets may be salvageable)
//   done           — published Release, regardless of pod state
//   unknown        — pod gone, no Release found (run failed before upload — what the
//                     user calls "pod terminated, no results")
type InferredStatus = "bootstrapping" | "training" | "uploading" | "partial" | "done" | "unknown" | "failed";

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

/** Parse the repo's `origin` url from .git/config. Returns null if not GitHub. */
function resolveOwnerRepo(): { owner: string; repo: string } | null {
  try {
    const cfg = fs.readFileSync(GIT_CFG, "utf8");
    const m = cfg.match(/url\s*=\s*(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/\s.]+?)(?:\.git)?\s*$/m);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  } catch {
    return null;
  }
}

async function getPodState(podId: string): Promise<{ alive: boolean; desiredStatus: string | null; error?: string }> {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) return { alive: false, desiredStatus: null, error: "RUNPOD_API_KEY not set" };
  try {
    const r = await fetch(`${RUNPOD_GQL}?api_key=${apiKey}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query Pod($id: String!) { pod(input:{podId:$id}) { id desiredStatus runtime { uptimeInSeconds } } }`,
        variables: { id: podId },
      }),
      // Next 14 caches identical fetch URLs by default. Without no-store the
      // dashboard kept reporting alive:true on a pod that had been gone for
      // hours — the user's session went silently blind to a dead pod.
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return { alive: false, desiredStatus: null, error: `RunPod ${r.status}` };
    const body = await r.json();
    const pod  = body?.data?.pod;
    if (!pod) return { alive: false, desiredStatus: null };
    return { alive: pod.desiredStatus === "RUNNING", desiredStatus: pod.desiredStatus };
  } catch (e) {
    return { alive: false, desiredStatus: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function getRelease(owner: string, repo: string, tag: string): Promise<{ url: string; draft: boolean } | null> {
  const token = process.env.GITHUB_TOKEN;
  // Public repos work without a token; private repos require it.
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const r = await fetch(`${GH_API}/repos/${owner}/${repo}/releases/tags/${tag}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (r.status === 404) return null;
    if (!r.ok) return null;
    const body = await r.json();
    return { url: body.html_url as string, draft: Boolean(body.draft) };
  } catch {
    return null;
  }
}

export async function GET() {
  const st = readState();
  const podId  = typeof st.pod_id  === "string" ? st.pod_id  : null;
  const runTag = typeof st.run_tag === "string" ? st.run_tag : null;
  const localStatus = typeof st.status === "string" ? st.status : "idle";

  // No active run on disk
  if (!podId && !runTag) {
    return NextResponse.json({
      inferredStatus: "idle" as const,
      pod: null,
      release: null,
      state: st,
    });
  }

  // Run failed locally before pod was even created
  if (localStatus === "failed" && !podId) {
    return NextResponse.json({
      inferredStatus: "failed" as const,
      pod: null,
      release: null,
      state: st,
    });
  }

  const owner_repo = resolveOwnerRepo();
  const podState   = podId  ? await getPodState(podId) : null;
  const release    = (owner_repo && runTag)
    ? await getRelease(owner_repo.owner, owner_repo.repo, runTag)
    : null;

  let inferred: InferredStatus = "unknown";
  if (release && !release.draft) {
    inferred = "done";
  } else if (release && release.draft && podState?.alive) {
    inferred = "uploading";
  } else if (release && release.draft && !podState?.alive) {
    // Draft release with a dead pod = orchestrator started uploading then died.
    // The user can still pull whatever assets were uploaded before the crash.
    inferred = "partial";
  } else if (podState?.alive) {
    inferred = "training";
  } else if (!podId) {
    inferred = "bootstrapping";
  } else if (podState && !podState.alive) {
    inferred = "unknown";
  }

  return NextResponse.json({
    inferredStatus: inferred,
    pod: podState,
    release,
    runTag,
    podId,
    ownerRepo: owner_repo,
    state: st,
  });
}
