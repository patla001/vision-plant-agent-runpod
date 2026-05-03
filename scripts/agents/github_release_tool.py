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


def upload_asset(release_id: int, owner: str, repo: str, file_path: Path, token: str) -> dict:
    """Upload a single file as a Release asset. Returns the API response."""
    if not file_path.exists():
        raise FileNotFoundError(file_path)

    headers = _auth_headers(token)
    headers["Content-Type"] = "application/octet-stream"

    # GitHub's upload endpoint takes the filename as a query parameter.
    with file_path.open("rb") as fh:
        r = requests.post(
            f"{UPLOAD_HOST}/repos/{owner}/{repo}/releases/{release_id}/assets",
            headers=headers,
            params={"name": file_path.name},
            data=fh,
            timeout=300,   # large files (.tflite) can take a while
        )
    r.raise_for_status()
    return r.json()


def upload_all(
    release_id: int,
    owner: str,
    repo: str,
    files: list[Path],
    token: str,
) -> list[dict]:
    """Upload multiple assets sequentially. Skips files that don't exist."""
    results = []
    for f in files:
        if not f.exists():
            print(f"[github_release] Skipping missing file: {f}", flush=True)
            continue
        print(f"[github_release] Uploading {f.name} ({f.stat().st_size / 1e6:.1f} MB)...", flush=True)
        results.append(upload_asset(release_id, owner, repo, f, token))
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


def collect_artifact_files(results_dir: Path) -> list[Path]:
    """Return the set of files we want attached to a Release.

    Strategy:
      - The .tflite at the top of results_dir (training_wrapper writes here)
      - Every .png in any descendant directory (training curves, confusion matrix)
      - Every .json/.csv in the timestamped run subdir
      - analysis_report.md if present
    """
    files: list[Path] = []

    tflite = results_dir / "plant_classifier_deep_learning.tflite"
    if tflite.exists():
        files.append(tflite)

    report = results_dir / "analysis_report.md"
    if report.exists():
        files.append(report)

    for ext in ("*.png", "*.csv", "*.json", "*.txt"):
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
