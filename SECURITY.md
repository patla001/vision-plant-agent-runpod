# Security Notes

This file documents the deliberate security tradeoffs made in this project so future contributors understand why certain "best practice" rules are intentionally relaxed.

## Threat model

This project is a **single-user, locally-run** ML pipeline. It is **not** designed for:
- Multi-tenant deployment
- Public-facing dashboards
- Untrusted user input
- Production use without further hardening

All API routes assume the dashboard is running on `localhost` and accessed by the developer who owns the RunPod and Anthropic accounts.

---

## Deliberate tradeoffs

### 1. `StrictHostKeyChecking=no` on every SSH call

Every SSH command in the pipeline includes:
```bash
ssh -p <port> -o StrictHostKeyChecking=no root@<ip> ...
```

**Why:** RunPod pods are ephemeral — a new pod is provisioned for every training run, with a fresh public IP. Standard host-key TOFU (trust on first use) would prompt for confirmation on every run, blocking the automated agent. Storing the host key would require a per-pod cache that's discarded immediately when the pod is terminated.

**Risk:** A network-position attacker could MITM the SSH connection during the brief pod lifetime (typically 3–4 hours per run).

**Mitigation:** RunPod's SSH key authentication still applies — your private key (`~/.ssh/id_ed25519`) is required. An attacker would have to both intercept the connection *and* hold your private key. The window is small and the impact is limited to one training run's data.

**To harden:** Add `UserKnownHostsFile=~/.ssh/known_hosts.runpod`, fetch the pod's host fingerprint via the RunPod API after provisioning, and verify on connect. This is more work than it's worth for a course project; it would be required for production.

### 2. No CSRF or auth on `/api/pipeline/*` routes

The dashboard's POST endpoints (`/api/pipeline/start`, future `/api/pipeline/abort`) accept any request from any origin without authentication.

**Why:** The dashboard is meant to be run with `pnpm dev` on `localhost` only. Adding auth would add friction for the single intended user.

**Risk:** If the dashboard is ever exposed beyond localhost (e.g., via `--host 0.0.0.0`, port forwarding, or deploying to Vercel), an unauthenticated visitor could:
- Trigger pod provisioning (costs you money on RunPod)
- Read training results
- Read pod connection details from `pipeline_state.json`

**Mitigation:** Don't expose the dashboard beyond localhost. If you must:
- Add a `middleware.ts` checking a session cookie
- Or put a reverse proxy with HTTP basic auth in front

### 3. `.env` file with plaintext API keys

API keys are stored in plaintext in `.env`. The file is gitignored, so it never reaches GitHub.

**Why:** Standard practice for local dev. Any "secrets manager" would be overkill for a single-user project.

**Risk:** Anyone with read access to your filesystem (other users on a shared machine, malware) can extract the keys.

**Mitigation:**
- Use macOS FileVault / Linux LUKS so the disk is encrypted at rest
- Don't run this on shared/public machines
- Rotate keys if you suspect a leak

### 4. Subprocess calls bypass shell

✅ **This one we get right.** All subprocess calls in `scripts/agents/orchestrator.py` and `scripts/agents/monitor_agent.py` use list arguments to `subprocess.run()` and `spawn()` — never `shell=True`. This prevents command injection even if pod inputs were somehow attacker-controlled.

```python
# ✅ Safe — list form, no shell
subprocess.run(["ssh", "-p", str(port), f"root@{ip}", cmd], ...)

# ❌ Would be unsafe — never do this
subprocess.run(f"ssh -p {port} root@{ip} {cmd}", shell=True, ...)
```

### 5. Path traversal protection in `/api/image`

The `/api/image` route serves PNG files from the `results/` directory. It validates the `run` and `file` query parameters with strict regex whitelists, then asserts the resolved path is inside `RESULTS_ROOT`. See `dashboard/app/api/image/route.ts`.

---

## Reporting a security issue

If you find a vulnerability that affects deployed instances of this project (not just a local-dev edge case), please open a GitHub issue with the `security` label or email the repo owner directly.

For this codebase specifically, the highest-impact issues would be:
- An attacker-controlled value reaching `subprocess.run` without list-form safety
- A path traversal in any `/api/*` route that reads files
- Leaking RunPod or Anthropic API keys to the client (Next.js inadvertently shipping them in a client bundle)
