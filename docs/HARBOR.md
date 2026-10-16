# Public ReviewBench on Harbor

Run the public **219-PR** benchmark with Copilot CLI's native `/review`, score
its findings in a separate verifier, and optionally upload the verified results
to Harbor Hub. Execution uses CPU-only Linux x86-64 sandboxes; no GPU is needed.

| Component | Version or reference |
| --- | --- |
| Public dataset | [`review-bench/reviewbench-public@v1`](https://hub.harborframework.com/datasets/review-bench/reviewbench-public) |
| Harbor | `0.24.0`, installed automatically from the package's dependency pin |
| Reviewer CLI inside the sandbox | `1.0.96`, downloaded and SHA-256 verified by the adapter |
| Host CLI used for login | `1.0.98` |
| Judge | Anthropic `claude-opus-5`, via `api.anthropic.com` |
| Judge SDK | `@earendil-works/pi-coding-agent@0.75.5` |

The adapter invokes the real interactive `/review` command, requires evidence
that its code-review tool succeeded, and converts findings without an LLM
rewrite. Copilot selects the review model; **do not pass `-m`**.
The judge preserves the existing ReviewBench matcher, classifier, and scoring:
adaptive thinking, low matcher effort, medium classifier effort, and an
8,192-token output budget.

The dataset is public and requires no Hub login. You need a Copilot-enabled
GitHub account and a separate Anthropic API key with access to the judge.
Review and judging incur charges. Results are self-funded benchmark runs, not
automatic official leaderboard submissions.

## 1. Prepare Ubuntu and Docker

Use a Linux Docker runner or **WSL2 Ubuntu with Docker Desktop** on Windows.
Harbor must run inside Ubuntu, not native PowerShell.

For a new Windows installation, run in Administrator PowerShell:

```powershell
wsl --install -d Ubuntu
winget install --exact --id Docker.DockerDesktop
```

Docker's actual kernel must support `CONFIG_NFT_FIB_INET=y` or `m`.
The validated Windows setup uses **WSL 3.0.3 / kernel 6.18.54.1**; the older
6.6.87.2 WSL kernel does not satisfy this requirement.
Update WSL with `wsl --update`. If that returns HTTP 403, use Microsoft's
[official WSL 3.0.3 installer](https://github.com/microsoft/WSL/releases/tag/3.0.3)
for your architecture and verify its Microsoft signature.
Save work before restarting WSL to load the new kernel.

Start Docker Desktop, use Linux containers, and enable **Settings > Resources >
WSL Integration > Ubuntu**, then **Apply & Restart**. Do not also install a
second Docker engine inside Ubuntu.

Open Ubuntu from PowerShell:

```powershell
wsl -d Ubuntu
```

All remaining commands run in **Ubuntu Bash**. Install the host tools:

```bash
sudo apt-get update &&
sudo apt-get install -y git curl ca-certificates libsecret-tools

curl -LsSf https://astral.sh/uv/install.sh | sh
curl -fsSL https://gh.io/copilot-install | VERSION=v1.0.98 bash
export PATH="$HOME/.local/bin:$PATH"

docker info
docker compose version
```

## 2. Install Harbor and the adapter together

The public Python package contains both the run plugin/checkers and
`reviewbench_copilot.local_agent:NativeCopilotReview`. There is no separate
private adapter download and no host-side Node.js requirement.
While this change is under review, install from this PR's public Git ref:

```bash
uv tool install --force --python 3.12 --with-executables-from harbor \
  "reviewbench-harbor @ git+https://github.com/review-bench/ReviewBench.git@refs/pull/51/head"
```

This installs Harbor, the adapter, plugin, and checkers in one isolated Python
environment. ReviewBench's package metadata pins the compatible Harbor release;
users do not need a Harbor Git commit or a separate runtime wheel URL.
The reviewer image remains harness-neutral; the adapter uploads its verified
CLI archive without requiring reviewer-side installation access.

### Updating independently

Updates are explicit, not automatic. Do not upgrade an environment while a job
is running.

| Change | User action |
| --- | --- |
| Runtime, adapter, or Harbor compatibility | Run `uv tool upgrade reviewbench-harbor`; the package selects its tested Harbor dependency |
| Dataset, reference findings, or judge policy | Select the newly published dataset version, such as `review-bench/reviewbench-public@v2`, once available; normally no tool reinstall is needed |
| Judge API key | Set `RB_HARBOR_JUDGE_KEY` for the next run; no installation change |

The PR ref above is a temporary pre-release source, not an immutable release.
Released installations should use a versioned ReviewBench package artifact.
Published dataset versions keep their frozen judge and task identities:
upgrading the runtime does not silently replace the judge or dataset, and a
changed judge policy must use a new dataset version. Keep the package version
and dataset version with run evidence; do not compare changed judge versions
as if they were the same benchmark.

## 3. Authenticate and check readiness

Log in **inside Ubuntu**; a Windows Copilot login is not automatically shared:

```bash
copilot login --device-code
```

Open the displayed URL, authorize the device code, and wait for the terminal
to confirm success. If no system keychain is available, the CLI asks whether
to save the token in its owner-only plaintext configuration. Accept only if
that storage is appropriate for your runner. Never print or upload that file.

Check the exact credential loader and Docker kernel capability before spending
model requests:

```bash
"$(uv tool dir)/reviewbench-harbor/bin/python" - <<'PY'
from harbor.environments.docker.docker import DockerEnvironment
from reviewbench_copilot.local_agent import reviewer_token

reviewer_token()
if not DockerEnvironment._egress_control_kernel_support():
    raise SystemExit("Docker kernel lacks Harbor's required network-isolation support.")
print("Reviewer credential and Docker kernel checks passed; no token displayed.")
PY
```

Unsupported network policies must fail; do not bypass the check or disable
isolation. The adapter supports the CLI's saved `authTokens` plaintext format,
legacy saved credentials, Linux keychain lookup, or an explicitly supplied
`COPILOT_GITHUB_TOKEN`. Only the selected account's credential is used.

## 4. Run, then verify

Start with one PR. Enter the **Anthropic judge key**, not a GitHub token, at the
hidden prompt; `export` succeeding silently is normal.

```bash
mkdir -p ~/reviewbench-copilot
cd ~/reviewbench-copilot

read -rsp 'Anthropic judge key: ' RB_HARBOR_JUDGE_KEY
printf '\n'
export RB_HARBOR_JUDGE_KEY

job="copilot-smoke-$(date +%Y%m%d-%H%M%S)"

harbor run \
  -d review-bench/reviewbench-public@v1 \
  -a reviewbench_copilot.local_agent:NativeCopilotReview \
  -e docker \
  --plugin reviewbench_harbor.reviewbench_plugin:ReviewBenchPlugin \
  -n 1 -l 1 -k 1 \
  --job-name "$job" \
  --yes &&
reviewbench-check-job \
  "jobs/$job" \
  "jobs/$job/reviewbench-metric.py" \
  --output "$job-metrics.json" >/dev/null &&
printf '\nVerification passed. Metrics: %s\n' "$job-metrics.json"

unset RB_HARBOR_JUDGE_KEY
```

Keep the terminal open. The judge key is mapped to `ANTHROPIC_API_KEY` **only
inside the separate verifier**. The reviewer receives its own Copilot
credential, not the judge key, goldens, or verifier assets. It is restricted to
the published endpoint allowlist.

Use the same command with a new job name and these controls for larger runs:

| Run | Flags | Planned trials |
| --- | --- | --- |
| One-PR smoke | `-n 1 -l 1 -k 1` | 1 |
| First 50 PRs, concurrency 10 | `-n 10 -l 50 -k 1` | 50 |
| All 219 PRs, concurrency 10 | `-n 10 -k 1` | 219 |

`-n` caps concurrent trials, `-l` limits the selected tasks, and `-k` repeats
each selected task. A limit selects a subset, not a random sample. Set a fresh
`job` and export the judge key again if it was unset. Concurrency also depends
on Docker resources and both providers' rate limits; one trial can make
multiple model requests.

The plugin freezes task/evaluation identities and round membership in
`reviewbench-plan.json`, and retains `reviewbench-metric.py` inside the job.
Each round is scored independently; complete repeated runs report means,
population standard deviations, and defined-round counts. Attempts are not
pooled or selected by best score. Resume only with the same configuration and
plugin; keep failed evidence instead of turning failures into empty findings.

## 5. Interpret the results

**"1/1 Complete" or Harbor's exit code alone is not the scoring gate.**
Require the checker to succeed, `complete=1`, the intended `expected_prs`,
`scored_trials=expected_prs*n_attempts`, and no trial exceptions or duplicates.
`source_prs=219` and `expected_prs=219` are required for a full benchmark.

Use the named metrics in `$job-metrics.json` or the job's
`reviewbench-summary.json`:

| Field | Meaning |
| --- | --- |
| `summary.micro.overall.grounded_precision.mean` | True-positive matched findings / all reference-matched findings |
| `summary.micro.overall.grounded_recall.mean` | Reference true-positive issues covered / reference true-positive issues |
| `summary.micro.overall.augmented_precision.mean` | Also credits unmatched findings judged valid |
| `summary.micro.overall.augmented_recall.mean` | Recall with valid novel findings added to the reference set |
| `round.1.*` | One round's counts, scores, severity/category breakdowns |

Macro metrics average per-PR results; micro metrics pool the underlying counts.
Undefined ratios remain undefined, not zero. The terminal's **Reward / Count**
table mixes count fields and flags without useful labels. Large `rb_task` and
`rb_evaluation` numbers are integrity identifiers, not scores.
A successful one-PR smoke establishes integration, not overall reviewer quality.

## 6. Optional private Hub upload

After verification, inspect the job for credentials or other sensitive content.
From the same terminal:

```bash
harbor auth login --no-browser
harbor upload "jobs/$job" --private
```

Follow the returned Hub link to inspect the job. Uploads are not automatic
and do not create official ReviewBench leaderboard entries. Preserve the job
directory's original basename, plan, metric, findings, native proof, and judge
evidence. Recheck downloaded jobs with their retained metric before trusting
their scores.

## Maintainer checks

`npm run harbor:export` builds frozen task packages; `npm run
harbor:validate-findings` checks the findings contract without inference.
Exports preserve pinned base/HEAD commits, the existing matcher/classifier,
separate verifier execution, exact-host network policies, and content digests.
The standard Anthropic Opus 5 model definition is explicit, not an alias.
Changing sources or judge policy requires newly versioned evaluation identities;
do not overwrite the published `v1` profile.

CI covers schema/content validation, scorer parity, native run controls, Copilot
credential and findings-format regressions, installed-wheel behavior, and
no-inference Docker isolation/CLI setup. It does not run paid reviews or publish
datasets, images, results, or leaderboard entries.
