"""GitHub Release helper for the pod-side orchestrator.

Creates a tagged Release and uploads training artifacts (.tflite, plots,
metrics CSVs, analysis report) as Release assets. Used by pod_orchestrator
right before self_terminate so results survive the pod's destruction.

Required env: GITHUB_TOKEN with `contents: write` scope on the target repo.

The repo owner/name pair is auto-detected from the cloned repo's
`remotes.origin.url` if not explicitly passed — see resolve_owner_repo().
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import requests

GH_API = "https://api.github.com"
UPLOAD_HOST = "https://uploads.github.com"


def resolve_owner_repo(repo_dir: Path) -> tuple[str, str]:
    """Return (owner, repo) by inspecting the git remote in repo_dir."""
    out = subprocess.run(
        ["git", "-C", str(repo_dir), "remote", "get-url", "origin"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    # Match both https://github.com/owner/repo[.git] and git@github.com:owner/repo[.git]
    m = re.match(r"(?:https://github\.com/|git@github\.com:)([^/]+)/([^/]+?)(?:\.git)?/?$", out)
    if not m:
        raise ValueError(f"Could not parse GitHub owner/repo from remote URL {out!r}")
    return m.group(1), m.group(2)


def _auth_headers(token: str) -> dict:
    return {
        "Accept":               "application/vnd.github+json",
        "Authorization":        f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def create_release(
    owner: str,
    repo: str,
    tag: str,
    name: str,
    body: str,
    token: str,
    draft: bool = False,
    prerelease: bool = False,
) -> dict:
    """Create a Release. Returns the API response (includes `id` and `upload_url`)."""
    r = requests.post(
        f"{GH_API}/repos/{owner}/{repo}/releases",
        headers=_auth_headers(token),
        json={
            "tag_name":   tag,
            "name":       name,
            "body":       body,
            "draft":      draft,
            "prerelease": prerelease,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def upload_asset(
    release_id: int,
    owner: str,
    repo: str,
    file_path: Path,
    token: str,
    name: str | None = None,
) -> dict:
    """Upload a single file as a Release asset.

    `name` overrides the on-Release asset name. Defaults to file_path.name.
    Returns the API response.
    """
    if not file_path.exists():
        raise FileNotFoundError(file_path)

    headers = _auth_headers(token)
    headers["Content-Type"] = "application/octet-stream"
    asset_name = name or file_path.name

    # GitHub's upload endpoint takes the filename as a query parameter.
    with file_path.open("rb") as fh:
        r = requests.post(
            f"{UPLOAD_HOST}/repos/{owner}/{repo}/releases/{release_id}/assets",
            headers=headers,
            params={"name": asset_name},
            data=fh,
            timeout=300,   # large files (.tflite) can take a while
        )
    r.raise_for_status()
    return r.json()


def _unique_asset_name(file_path: Path, results_dir: Path, used: set[str]) -> str:
    """Generate a GitHub asset name that hasn't been used on this release yet.

    Strategy: prefer the bare filename. On collision, walk up the path under
    results_dir prefixing each parent dir name (joined by '_') until unique.
    Last-resort fallback appends a counter so we never silently drop a file.

    Examples (results_dir = /workspace/results):
      results_dir/foo.png                                       → "foo.png"
      results_dir/single_split/foo.png  (after foo.png used)    → "single_split_foo.png"
      results_dir/split_metrics/test/foo.png (both used)        → "test_foo.png"
                                                                  or "split_metrics_test_foo.png"
                                                                  if "test_foo.png" already taken
    """
    base = file_path.name
    if base not in used:
        return base
    try:
        rel_parts = file_path.relative_to(results_dir).parts
    except ValueError:
        rel_parts = (file_path.name,)
    # Try increasingly long prefixes from the path
    for i in range(len(rel_parts) - 2, -1, -1):
        candidate = "_".join(rel_parts[i:])
        if candidate not in used:
            return candidate
    # Pathological collision (deep duplicates) — append a counter
    n = 2
    while f"{n}_{base}" in used:
        n += 1
    return f"{n}_{base}"


def upload_all(
    release_id: int,
    owner: str,
    repo: str,
    files: list[Path],
    token: str,
    *,
    results_dir: Path | None = None,
) -> list[dict]:
    """Upload multiple assets sequentially. Tolerant of two failure modes
    that previously broke whole runs:

      1. **Filename collision.** PlantNet's per-split metrics directories
         (single_split/, split_metrics/{test,train,validation}/) all contain
         a file literally named ``confusion_matrix_normalized.png`` — so the
         old code would upload the first one, then 422 on every subsequent
         duplicate name. Now we dedup by name; on collision we re-use a
         path-prefixed name (``test_confusion_matrix_normalized.png``) so
         the per-split artifact still ships, just with a distinct name.

      2. **Asset already exists from a prior partial run.** If the Release
         was created and some assets uploaded before a crash, the agent's
         retry would 422 with ``already_exists``. We now treat that as a
         no-op so the retry can complete.

    `results_dir` is used as the base for path-prefixing collisions. When
    omitted, falls back to each file's parent dir name.
    """
    used_names: set[str] = set()
    results: list[dict] = []
    for f in files:
        if not f.exists():
            print(f"[github_release] Skipping missing file: {f}", flush=True)
            continue
        if results_dir is not None:
            asset_name = _unique_asset_name(f, results_dir, used_names)
        else:
            # Conservative fallback: use parent dir prefix on collision
            asset_name = f.name
            if asset_name in used_names:
                asset_name = f"{f.parent.name}_{f.name}"
                while asset_name in used_names:
                    asset_name = f"{f.parent.parent.name}_{asset_name}"
        used_names.add(asset_name)

        size_mb = f.stat().st_size / 1e6
        if asset_name == f.name:
            print(f"[github_release] Uploading {asset_name} ({size_mb:.1f} MB)...", flush=True)
        else:
            print(f"[github_release] Uploading {asset_name} (renamed from {f.name}, "
                  f"{size_mb:.1f} MB)...", flush=True)
        try:
            results.append(upload_asset(release_id, owner, repo, f, token, name=asset_name))
        except requests.HTTPError as e:
            # 422 with code "already_exists" means a prior (failed) run
            # already attached this exact asset name. Idempotent retry —
            # treat as success and move on instead of nuking the whole run.
            resp = e.response
            if resp is not None and resp.status_code == 422:
                already = False
                try:
                    body = resp.json()
                    if isinstance(body, dict):
                        errs = body.get("errors") or []
                        already = any(
                            isinstance(err, dict) and err.get("code") == "already_exists"
                            for err in errs
                        )
                except ValueError:
                    pass
                if already:
                    print(f"[github_release] {asset_name} already on release — skipping.",
                          flush=True)
                    continue
            raise
    return results


def find_release_by_tag(owner: str, repo: str, tag: str, token: str) -> dict | None:
    """Return the Release dict for a tag, or None if it doesn't exist."""
    r = requests.get(
        f"{GH_API}/repos/{owner}/{repo}/releases/tags/{tag}",
        headers=_auth_headers(token),
        timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def find_or_create_release(
    owner: str,
    repo: str,
    tag: str,
    name: str,
    body: str,
    token: str,
    draft: bool = False,
    prerelease: bool = False,
) -> dict:
    """Idempotent Release creation. Returns the existing Release if `tag`
    already has one (regardless of who/what created it), otherwise creates
    and returns a new Release.

    Why this matters: a prior crash mid-upload leaves the Release object
    behind. The agent's retry would then 422 on `create_release` because
    the tag exists — and the run loops until max_iterations. With this
    helper, the retry attaches to the existing Release and resumes the
    upload phase (which is itself idempotent via upload_all).
    """
    existing = find_release_by_tag(owner, repo, tag, token)
    if existing is not None:
        return existing
    return create_release(owner, repo, tag, name, body, token, draft, prerelease)


# Files we MUST publish if they exist on disk. These are the artifacts the
# downstream consumers (dashboard's sync-release route, AI-mode hyperparameter
# picker, manual recovery) actively look for. Listing them by name — instead
# of relying on rglob alone — gives the upload step a chance to log a loud
# warning when a critical file is missing, instead of silently dropping it.
# The 2026-05-05 run shipped a Release with only the .tflite + plots because
# rglob found nothing under those extensions; the suggester JSON, metrics CSV,
# and hyperparameters snapshot all went missing without a single log line.
REQUIRED_ARTIFACTS: tuple[str, ...] = (
    "plant_classifier_deep_learning.tflite",
    "suggested_hyperparameters.json",
    "hyperparameters_snapshot.json",
    "metrics_train_val_test.json",
    "split_summary.json",
    "loss_vs_epoch.png",
    "analysis_report.md",
    "training.log",
    "orchestrator.log",
)


def collect_artifact_files(results_dir: Path) -> list[Path]:
    """Return the set of files we want attached to a Release.

    Strategy:
      - First, every file in REQUIRED_ARTIFACTS that exists at the top level —
        these are the files downstream code actively reads (suggester JSON,
        snapshot, analysis report). Listing them explicitly means the caller
        can warn about each missing one by name.
      - Then every .png / .csv / .json / .txt anywhere under results_dir
        (rglob), to sweep up per-epoch metrics, ROC plots, label files, etc.
      - The .tflite is included via REQUIRED_ARTIFACTS, but we also keep the
        explicit add for backwards compatibility with anything calling this
        with a results_dir that doesn't satisfy the named-file checks.
    """
    files: list[Path] = []

    # Tier 1 — must-haves at top of results_dir.
    for name in REQUIRED_ARTIFACTS:
        p = results_dir / name
        if p.exists():
            files.append(p)
        else:
            print(f"[github_release] WARNING: expected artifact missing: {name}", flush=True)

    # Tier 2 — sweep every plot / CSV / JSON / TXT in any subdir
    # (per-epoch metrics, ROC plots, label files, etc.)
    for ext in ("*.png", "*.csv", "*.json", "*.txt", "*.md", "*.log"):
        files.extend(sorted(results_dir.rglob(ext)))

    # De-duplicate while preserving order
    seen: set[Path] = set()
    unique: list[Path] = []
    for f in files:
        if f not in seen:
            seen.add(f)
            unique.append(f)
    return unique


if __name__ == "__main__":
    # Smoke test: list releases for the current repo
    import sys
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("GITHUB_TOKEN not set", file=sys.stderr)
        sys.exit(1)
    repo_dir = Path(__file__).resolve().parents[2]
    owner, repo = resolve_owner_repo(repo_dir)
    print(f"Resolved repo: {owner}/{repo}")
    r = requests.get(f"{GH_API}/repos/{owner}/{repo}/releases", headers=_auth_headers(token), timeout=30)
    r.raise_for_status()
    for rel in r.json():
        print(f"  {rel['tag_name']}: {rel['name']}")
