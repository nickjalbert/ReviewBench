# ReviewBench user kit

This kit connects your reviewer to an approved ReviewBench task export or Hub
download. By default it references that dataset without changing it. With
explicit BYO judge options, it creates a private dataset copy inside the kit
with new judge settings and evaluation IDs. Neither mode installs credentials
or publishes results.
The dataset paths in `job.json` refer to the machine running Harbor; regenerate
the kit if you move the dataset or use a different execution machine.
The kit's `kit.json` records `task_count`: a full benchmark kit must contain
all 219 PR tasks, not the 25-PR test split or a smoke subset.

## Prepare

Install the supported Harbor CLI and `uv`. Cloud sandboxes also require the
matching Harbor provider extra and your sandbox account credentials. A Linux
Docker runner must support Harbor's network allowlists.

Set up your reviewer credential through the approved secret mechanism. Obtain
the approved verifier-only judge connection from the dataset maintainer; the
task export must already specify that connection and any required model
registration. This kit does not grant judge access.

For self-funded tuning, use the BYO judge options described below instead of
requesting access to the maintainer's judge connection.

Never put secret values in `job.json`, findings, source files, or command
arguments. Keep judge credentials confined to the verifier.

## Bring your own judge

From the ReviewBench source checkout, generate a kit with a registered API-key
judge provider/model, its exact endpoint hostname, and a verifier-only variable
mapping:

For a Harbor 0.24 Hub download, first restore its missing manifest from the
same pinned reference using `python scripts\harbor\check-format.py
<approved-dataset-directory> --hub-ref "<org>/<dataset>@<version-or-tag>"`.
This requires Harbor in that Python environment and Hub access, and verifies
all downloaded digests and exact task coverage before writing `dataset.toml`.
Skip this step for a local export that already contains the manifest.

```powershell
npm run harbor:onboard -- --dataset <approved-dataset-directory> --output .\.harbor\byo-kit --agent "<agent-name>" --model "<reviewer-provider>/<reviewer-model>" --environment docker --judge-provider anthropic --judge-model claude-sonnet-4-6 --judge-host api.anthropic.com --judge-env ANTHROPIC_API_KEY=RB_HARBOR_JUDGE_KEY
```

Use `--custom-agent` instead of the reviewer agent/model options for your own
harness. Supported BYO providers are `anthropic`, `openai`,
`azure-openai-responses`, `google`, `deepseek`, and `openrouter`. The model must
be recognized by the locked judge SDK; preparation rejects unknown models rather
than substituting another one. Repeat `--judge-host` or `--judge-env` for required
additional endpoints or provider-specific variables.

Provision `RB_HARBOR_JUDGE_KEY` on the **Harbor orchestrator** through your secret
manager before running the job. Its value is mapped to `ANTHROPIC_API_KEY` only
in the separate verifier. Supply a different reviewer credential independently.
Never put the judge key in agent `env`, job configuration, images, or command
arguments. Selecting hosted secrets for the reviewer is not verifier-only
delivery; use the approved CLI runner/provider secret mechanism.

The kit checks source task/metric digests, replaces the old judge credential
mapping, and records its BYO policy in `dataset/byo-judge.json`. It preserves the
PRs, goldens, reviewer instruction, and reviewer network policy. It changes the
judge's model, endpoint allowlist, evaluation IDs, task digests, and metric in
the **private copy**, never the source dataset or published package. Tasks with
private verifier overrides or prebuilt images are rejected; this path rebuilds
the canonical separate verifier.

Run `harbor run -c <byo-kit>\job.json`, then check the job using
`<byo-kit>\dataset\metric.py`, not the source dataset's metric. The user pays for
reviewer inference, judge inference, and their execution infrastructure. A BYO
score is for tuning only; it is not an official leaderboard submission.

## Use your agent

For a built-in agent, `job.json` already selects the agent and optional model
you supplied to `harbor:onboard`. Configure provider-specific nonsecret settings
in its `kwargs` if your endpoint needs them.

For a custom harness, edit `custom_agent.py`: implement `install()` and replace
the example CLI arguments in `run()` with your harness's invocation. The
template deliberately fails until installation is implemented. Convert native
output deterministically into the findings format; do not add or discard
findings during conversion.

Make the adapter importable before running a custom agent:

```powershell
$env:PYTHONPATH = (Get-Location).Path
```

Run this from the kit directory. On Linux, use `export PYTHONPATH="$PWD"`.

## Findings contract

The agent writes `/work/out/findings.json`:

```json
{
  "pr": {
    "repo": "https://github.com/owner/repo",
    "pr_number": 1,
    "base": "<task base SHA>",
    "head": "<task head SHA>"
  },
  "agent": "my-agent",
  "findings": [
    {
      "producer": "my-agent",
      "file": "src/example.ts",
      "start_line": 42,
      "end_line": 42,
      "message": "Describe the issue and its consequences."
    }
  ]
}
```

Copy PR identity from `/work/pr/pr.json`. Paths must be repository-relative,
use forward slashes, and refer to the frozen HEAD. Line numbers are positive
integers and `end_line` cannot precede `start_line`. An empty findings array is
valid; a missing file is not.

From the ReviewBench source checkout, validate sample output without a judge:

```powershell
npm run harbor:validate-findings -- --candidate <findings.json> --pr <task-directory>\environment\pr.json
```

This checks format and PR identity, not correctness of the reported issue.
The separate verifier repeats validation before scoring.

## Run, check, and upload

From the kit directory:

```powershell
harbor run -c .\job.json
```

After execution, from the ReviewBench source checkout:

```powershell
python scripts\harbor\check-job.py <kit-directory>\jobs\<job-name> <dataset-directory>\metric.py --output verified-metrics.json
```

Only complete, exception-free runs with the expected evaluation version pass.
To smoke-test, obtain a limited task export from the maintainer and generate
its own kit; do not submit a partial run of a full dataset as a complete score.
For a full run, keep one attempt per task and do not add task filters. Require
`complete=1`, `expected_prs=219`, and `scored_prs=219`; preserve failures and
interrupted-run evidence instead of fabricating empty reviews. Use the metric
for the exact executed judge/transport profile.

Inspect the job for secrets and private source before uploading:

```powershell
harbor auth login
harbor auth org list
harbor upload <job-directory> --private --org <approved-org>
```

Harbor organization membership is separate from GitHub organization membership.
Uploading results does not launch a hosted job or automatically publish a
ReviewBench leaderboard row.
Keep the uploaded directory basename equal to `job_name` in its `config.json`.
Download the uploaded job with `harbor jobs download <job-id> --output-dir <readback>`
and rerun the same `check-job.py` gate against the downloaded directory.
