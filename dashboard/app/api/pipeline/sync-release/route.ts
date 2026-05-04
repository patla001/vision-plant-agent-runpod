import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { writeLastRun } from "../../../../lib/last-run";

const ROOT    = path.resolve(process.cwd(), "..");
const RESULTS = path.join(ROOT, "results");
const STATE   = path.join(RESULTS, "pipeline_state.json");
const GIT_CFG = path.join(ROOT, ".git", "config");

const GH_API = "https://api.github.com";

function readState(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

function resolveOwnerRepo(): { owner: string; repo: string } | null {
  try {
    const cfg = fs.readFileSync(GIT_CFG, "utf8");
    const m = cfg.match(/url\s*=\s*(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/\s.]+?)(?:\.git)?\s*$/m);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch { return null; }
}

interface Asset {
  id: number;
  name: string;
  size: number;
  url: string;            // API-style URL (needs Accept: octet-stream)
  browser_download_url: string;
}

/**
 * Pulls every asset from the Release matching the run_tag in pipeline_state.json
 * down to results/<run_tag>/. Used after a pod-side run where the only durable
 * copy of artifacts is the GitHub Release.
 *
 * We download via the API URL with Accept: application/octet-stream so private
 * repos work too. Public repos work either way.
 *
 * This is a POST because it's an explicit user action with side effects (file
 * writes) and we don't want it to be triggered by accidental link follows.
 */
export async function POST() {
  const st = readState();
  const runTag = typeof st.run_tag === "string" ? st.run_tag : null;
  if (!runTag) {
    return NextResponse.json({ error: "No run_tag in pipeline_state.json — nothing to sync." }, { status: 400 });
  }

  const ownerRepo = resolveOwnerRepo();
  if (!ownerRepo) {
    return NextResponse.json({ error: "Could not resolve GitHub owner/repo from .git/config." }, { status: 500 });
  }

  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const relRes = await fetch(
    `${GH_API}/repos/${ownerRepo.owner}/${ownerRepo.repo}/releases/tags/${runTag}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (relRes.status === 404) {
    return NextResponse.json({ error: `Release ${runTag} not found.` }, { status: 404 });
  }
  if (!relRes.ok) {
    return NextResponse.json({ error: `GitHub returned ${relRes.status}` }, { status: 502 });
  }
  const release = await relRes.json();
  const assets: Asset[] = release.assets || [];

  const destDir = path.join(RESULTS, runTag);
  fs.mkdirSync(destDir, { recursive: true });

  const downloaded: { name: string; bytes: number }[] = [];

  for (const asset of assets) {
    const dest = path.join(destDir, asset.name);
    // Asset download requires Accept: octet-stream on the API URL.
    const aRes = await fetch(asset.url, {
      headers: { ...headers, Accept: "application/octet-stream" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!aRes.ok) {
      return NextResponse.json({
        error: `Failed to download ${asset.name}: ${aRes.status}`,
        downloaded,
      }, { status: 502 });
    }
    const buf = Buffer.from(await aRes.arrayBuffer());
    fs.writeFileSync(dest, buf);
    downloaded.push({ name: asset.name, bytes: buf.byteLength });

    // Special case: if this is the .tflite, also drop a top-level copy so
    // /api/results/tflite (which looks at results/plant_classifier_deep_learning.tflite)
    // continues to work without further changes.
    if (asset.name === "plant_classifier_deep_learning.tflite") {
      fs.writeFileSync(path.join(RESULTS, asset.name), buf);
    }
    // Same for the AI suggestion — top-level copy makes /api/results/
    // suggested-hyperparameters a fast O(1) read on next start.
    if (asset.name === "suggested_hyperparameters.json") {
      fs.writeFileSync(path.join(RESULTS, "last_suggested_hyperparameters.json"), buf);
    }
  }

  // Mutate pipeline_state.json so subsequent page loads pick up "done" automatically.
  const updated = { ...st,
    status:       "done",
    current_step: `Synced ${downloaded.length} assets from Release ${runTag}`,
    finished_at:  st.finished_at ?? new Date().toISOString(),
    release_url:  release.html_url,
  };
  fs.writeFileSync(STATE, JSON.stringify(updated, null, 2));

  // Durable outcome record — survives /api/pipeline/reset so the home-page
  // last-run banner can always tell the user this run produced saved results.
  writeLastRun({
    run_tag:       runTag,
    outcome:       "completed_synced",
    finished_at:   new Date().toISOString(),
    pod_id:        typeof st.pod_id === "string" ? st.pod_id : undefined,
    color_correct: typeof st.color_correct === "string" ? st.color_correct : undefined,
    hp_mode:       typeof st.hp_mode === "string" ? st.hp_mode : undefined,
    release_url:   release.html_url,
    asset_count:   downloaded.length,
  });

  return NextResponse.json({
    ok:           true,
    runTag,
    destDir:      path.relative(ROOT, destDir),
    downloaded,
    releaseUrl:   release.html_url,
    assetCount:   downloaded.length,
  });
}
