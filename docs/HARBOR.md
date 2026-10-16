# ReviewBench on Harbor (experimental)

This adapter exports one frozen pull request per Harbor task. It preserves the
ReviewBench findings contract and uses the existing TypeScript matcher,
classifier, and scorer in a **separate verifier sandbox**. It does not publish
anything, start jobs, or replace the official ReviewBench submission portal.

This integration provides shared dataset packaging, harness onboarding, native
run controls, scoring, and result validation. Vendor-specific review runners,
private deployment configurations, credentials, and internal user-acceptance
launchers are not part of the adapter. The onboarding kit provides a generic
custom-agent template, not a preinstalled vendor harness.

The format targets Harbor **v0.24.0**, commit
`b53b8134e1241686dca7759af188f987ecc48e8b`: task schema 1.3 and dataset schema 1.0.
Vendor reviewer containers are not automatically Harbor agents. Start with a
built-in agent; hosted custom reviewers need Harbor's
[ACP integration](https://docs.harborframework.com/hosted-harbor/custom-agents).

## Vendor execution path

The primary path is **Harbor CLI execution, followed by result upload**.
Vendors can run the CLI on an approved Linux Docker runner, or use an approved
cloud sandbox through `--env` / `environment.type`. Direct cloud execution needs
that provider's credentials and optional Harbor dependencies; it does **not**
require Harbor Hosted Alpha access or Docker on the vendor's workstation.
The chosen provider must support this task's separate verifier and exact-host
network policies. Unsupported policies must fail rather than be disabled.

These are different operations:

| Operation | Purpose | Hosted Alpha needed? |
| --- | --- | --- |
| `harbor run -c job.yaml` | CLI orchestrates execution on the configured runner or sandbox | No |
| `harbor upload <job-directory> --private` | Store and share existing job results on Hub | No hosted execution |
| `harbor run --launch -c job.yaml` | Ask Harbor's hosted service to execute the job | May require access approval |

Use the CLI path for private tuning and integration testing. Uploading a job
does not automatically add a ReviewBench leaderboard row or make vendor-supplied
scores authoritative; the complete run and scoring provenance must be checked
before a submission is accepted.

## Published standard dataset

The [public 219-PR dataset](https://hub.harborframework.com/datasets/review-bench/reviewbench-public)
is available as **`review-bench/reviewbench-public@v1`**, including all frozen PR
identities, golden findings, the separate verifier, and the matching metric.
It can be downloaded without Harbor sign-in or organization membership.

Its default judge is **Anthropic Claude Opus 5**, exact API model ID
`claude-opus-5`, through the standard `api.anthropic.com` endpoint. Export your
own judge credential as `RB_HARBOR_JUDGE_KEY`; it becomes `ANTHROPIC_API_KEY`
**only in the verifier**. Give the reviewer a separate credential. The explicit
model registry enables adaptive thinking with low matcher effort, medium
classifier effort, and an 8,192-token output execution budget, without
substituting another model. The dataset's
`profile.json` records the policy, SDK version, source commit, and public
reviewer endpoint allowlist.

The reviewer image is harness-neutral: bring a compatible installed Harbor
agent or custom adapter that produces the documented findings. The dataset
does not install a vendor harness or include private endpoints, credentials,
or internal inference transports. Public task packages use their own
`rb-public-` namespace, separate from private tuning profiles.

This is an offline/self-funded scoring profile, not automatic leaderboard
acceptance. Publication did not invoke paid models; your provider account must
have access to the requested judge. Changing the judge or endpoint policies
requires a separately versioned profile.

## Run without a source checkout

Normal benchmark consumers do **not** need to clone ReviewBench, install Node.js,
run `npm ci`, or generate a kit. Install the generic Python runtime alongside
the pinned Harbor SDK, obtain an approved compatible dataset reference from its
maintainer, and bring an installed Harbor agent.

The experimental `harbor-runtime-v0.1.0rc1` GitHub prerelease supplies the
`reviewbench-harbor` wheel and `SHA256SUMS`. On a Linux runner with Python 3.12,
Git, `uv`, and a supported sandbox:

```bash
set -euo pipefail
mkdir reviewbench-run && cd reviewbench-run
curl -fLO https://github.com/review-bench/ReviewBench/releases/download/harbor-runtime-v0.1.0rc1/reviewbench_harbor-0.1.0rc1-py3-none-any.whl
curl -fLO https://github.com/review-bench/ReviewBench/releases/download/harbor-runtime-v0.1.0rc1/SHA256SUMS
sha256sum -c SHA256SUMS
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install uv \
  "harbor @ git+https://github.com/harbor-framework/harbor.git@b53b8134e1241686dca7759af188f987ecc48e8b" \
  ./reviewbench_harbor-0.1.0rc1-py3-none-any.whl
# Set your reviewer credential separately; provide an Anthropic key for the judge.
: "${RB_HARBOR_JUDGE_KEY:?Set your verifier-only Anthropic API key}"
# Replace the agent/model placeholders with a compatible installed reviewer.
harbor run -d "review-bench/reviewbench-public@v1" \
  -a "<agent-name-or-module:Class>" -m "<provider/model>" -e docker \
  --plugin reviewbench_harbor.reviewbench_plugin:ReviewBenchPlugin \
  -n 1 -l 1 -k 1 --job-name smoke --jobs-dir jobs --yes
reviewbench-check-job jobs/smoke jobs/smoke/reviewbench-metric.py \
  --output verified-metrics.json
```

Installing the pinned SDK may fetch Harbor's own source automatically; no
manual ReviewBench checkout or host-side JavaScript installation is needed.
The command starts model execution; credentials, model costs, sandbox support,
and dataset access remain the user's responsibility. For Docker, require a
Linux daemon with working Harbor network allowlists. Never disable the policy.
The dataset already contains the separate verifier and its judging dependencies.
The public dataset needs no Harbor sign-in; private datasets and result uploads
require an authorized Harbor account.
The generic wheel does not contain vendor-specific adapters, private profiles,
or credentials. A custom adapter must be installed into the **same environment**
as Harbor, and the dataset's reviewer image and endpoint policy must support it.

`-n`, `-l`, and `-k` below apply unchanged to this installed plugin. Omit `-m`
only for an agent that selects and records its own model. The plugin retains the
selected profile's metric in the job; use that retained metric for validation.
`reviewbench-check-dataset` also provides the export/digest check described below,
without a source checkout.

## Generate a user kit (maintainers and local customization)

Given an approved local task export, create a model-independent user kit:

```powershell
npm run harbor:onboard -- --dataset .\.harbor\smoke --output .\.harbor\my-kit --agent codex --model "<provider>/<reviewer-model>" --environment docker
harbor run -c .\.harbor\my-kit\job.json
```

The kit includes a ready job configuration, the dataset's custom metric, a
custom-harness adapter template, a harness-independent run plugin, an offline
checker, and findings-format instructions. Without
[BYO judge options](#self-funded-byo-judge), it references
the original dataset; it does not copy task assets, change the judge, or include
credentials. Generate it on the machine orchestrating Harbor so paths resolve.
Use `daytona`, `modal`, or `e2b` instead of `docker` for a supported, approved
cloud sandbox, with the matching Harbor provider dependencies and credentials.

For your own harness, replace `--agent ... --model ...` with `--custom-agent`,
then implement the generated `custom_agent.py` and make its directory importable.
The template intentionally fails until the harness installation is implemented.
Reviewer endpoints and credentials are yours; the approved judge connection and
its SDK registration must already be configured by the dataset maintainer.

Check a sample findings file without invoking any model:

```powershell
npm run harbor:validate-findings -- --candidate .\findings.json --pr .\.harbor\smoke\<task>\environment\pr.json
```

This uses the same format and PR-identity validator as the separate verifier.
It does not judge finding correctness. Start with a limited export for a
smoke test before running the full approved dataset.

## Native run controls for any harness

Use Harbor's own flags with the ReviewBench job plugin; no reviewer-specific
launcher is needed. This applies equally to a built-in agent or an importable
custom harness. Generate the kit on the orchestrator, then from the kit directory:

```powershell
$env:PYTHONPATH = (Get-Location).Path
harbor run -c .\job.json -p "<kit-dataset-path>" --plugin reviewbench_plugin:ReviewBenchPlugin -n 5 -l 10 -k 3
```

Use the dataset path recorded in `kit.json` (`<kit>\dataset` for BYO, otherwise
the approved source dataset). The pinned Harbor CLI requires an explicit `-p`
or `-d` when using `-l` or task filters, even when `-c` already references a
dataset. `-p` replaces that config's dataset selector; it does not append a
second dataset. On Linux, set `PYTHONPATH` with your shell's equivalent.

| Flag | Meaning |
| --- | --- |
| `-n 5` / `--n-concurrent 5` | At most five trials execute concurrently |
| `-l 10` / `--n-tasks 10` | Select at most ten tasks, after Harbor's task filters |
| `-k 3` / `--n-attempts 3` | Execute three independent attempts for every selected task |

The example schedules 30 trials if at least ten tasks match. Omit `-l` to run
the whole dataset. For a full 219-PR, three-round run, require 657 successful
trials. Rounds are logical attempt groups, not execution barriers: concurrency
may span rounds, and completion order cannot change round membership.

From a ReviewBench source checkout, the same plugin can also be used directly:

```powershell
$env:PYTHONPATH = (Get-Location).Path
harbor run -d "review-bench/reviewbench-public@v1" -a "<agent-name-or-module:Class>" -m "<provider/model>" --plugin scripts.harbor.reviewbench_plugin:ReviewBenchPlugin -n 5 -l 10 -k 3
```

That direct Hub example uses the published Claude Opus 5 judge and your own
`RB_HARBOR_JUDGE_KEY`. For a different judge, obtain a separately versioned
profile or use the canonical-export BYO workflow below.
The plugin does not install arbitrary harnesses, provide credentials, change
judge prompts, or relax the dataset's reviewer/verifier network policies.
Your chosen harness must already be compatible with those policies and the
findings contract. Each job selects one configured reviewer and one dataset;
run separate jobs for different reviewer configurations rather than mixing
their scores.

Before trials start, the plugin freezes the actual selected task IDs,
evaluation versions, and task/round-to-trial mapping in
`<job>\reviewbench-plan.json`. It retains a hash-checked
`reviewbench-metric.py` beside the job. These files distinguish an intentional
subset from an interrupted full run, without modifying the source tasks or
their evaluation IDs. The plugin is tested against the pinned Harbor 0.24
resolved-plan/metric interface; it rejects other versions rather than guessing.

Each complete round gets its own macro/micro scores under `round.<number>.*`.
Only when **all selected tasks in all k rounds** are valid does it report
`summary.<metric>.mean`, `.stddev` (population standard deviation), and
`.defined_rounds`. This averages the independently computed round scores;
it neither pools attempts into one micro score nor selects a best attempt.
Undefined ratios are excluded, with their defined-round counts reported,
never replaced with zero. A valid empty review is still scored normally.

The final Harbor metrics and `<job>\reviewbench-summary.json` use the same
strict offline gate:

```powershell
python .\check-job.py "<job-directory>" "<job-directory>\reviewbench-metric.py" --output .\verified-metrics.json
```

Require `complete=1`, the intended `expected_prs`, `n_attempts=k`,
`expected_trials=scored_trials=expected_prs*k`, and zero failed/duplicate
trials. A full benchmark also requires `source_prs=expected_prs=219`;
`full_dataset=1` alone only means all tasks in the source export, which may
itself be a smoke subset. Missing rounds, wrong versions, duplicate attempts,
and trial/step exceptions cannot produce a summary score. Harbor's process
exit alone is not this strict gate.

Resume with the same job configuration **and the same plugin**; frozen round
membership is preserved, including pending attempts. Changed scoring plans
require a new job directory. Keep the plan and metric snapshot when uploading
or downloading results, and validate the downloaded job again. Without the
plugin, the original dataset metric deliberately retains its strict
single-attempt, whole-dataset behavior.

## Self-funded BYO judge

The published standard dataset already uses your own Claude Opus 5 API key;
it does not require a BYO kit. To change the judge, use a clean canonical local
export supplied by its maintainer, or a canonical Hub export containing only
its manifest and metric. Do not layer another judge policy over an existing
versioned BYO profile. These maintainer/local-customization commands require a
source checkout:

```powershell
npm run harbor:onboard -- --dataset "<approved-canonical-export>" --output .\.harbor\byo-kit --agent "<agent-name>" --model "<reviewer-provider>/<reviewer-model>" --environment docker --judge-provider anthropic --judge-model claude-sonnet-4-6 --judge-host api.anthropic.com --judge-env ANTHROPIC_API_KEY=RB_HARBOR_JUDGE_KEY
harbor run -c .\.harbor\byo-kit\job.json
python scripts\harbor\check-job.py .\.harbor\byo-kit\jobs\reviewbench .\.harbor\byo-kit\dataset\metric.py --output .\.harbor\byo-kit\verified-metrics.json
```

Harbor 0.24 omits `dataset.toml` from Hub downloads. For a canonical Hub export,
`check-format.py <directory> --hub-ref "<org>/<dataset>@<version>"` restores that
manifest from the same pinned Hub version only after validating
all downloaded task and metric digests and exact task coverage. It requires
Harbor installed in that Python environment and Hub access. Local exports
already have a manifest; omit this restoration step for them.

Before execution, provision the host variable `RB_HARBOR_JUDGE_KEY` through your
secret manager. Do not pass its value in command arguments or the job file.
The task maps it to the provider API-key variable **only inside the separate
verifier**; give the reviewer its own credential. The user pays for their runner
and both models. Hub sign-in grants dataset access, not model access.

Supported API-key providers are `anthropic`, `openai`, `azure-openai-responses`,
`google`, `deepseek`, and `openrouter`. Choose a model registered by the locked
SDK; the example uses a registered model, not the private official judge.
Additional provider-specific variables and exact endpoint hosts can be mapped
with repeated `--judge-env` and `--judge-host` options. No personal model
registry, executable custom transport, or credential value is copied into the kit.

For an Azure deployment, repeated `--judge-setting KEY=VALUE` options can pin
the nonsecret `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_VERSION`, and
`AZURE_OPENAI_DEPLOYMENT_NAME_MAP` settings. The deployment map must explicitly
map the requested model ID to one deployment, such as
`my-judge-model=my-deployment`. These values become part of the profile fingerprint;
do not use `--judge-setting` for API keys.

The locked Azure transport normalizes Azure resource URLs to `/openai/v1`.
Use a compatible API version (normally `--judge-setting AZURE_OPENAI_API_VERSION=v1`);
a legacy preview version may fail on that route. Verify the actual SDK request
before starting a benchmark, rather than relying on a successful raw HTTP call
to a different route.

If the locked SDK does not list your model, `--judge-model-config <models.json>`
accepts an explicit, declarative SDK model definition for the selected provider
and model. For example:

```json
{
  "providers": {
    "azure-openai-responses": {
      "baseUrl": "https://your-resource.openai.azure.com/openai",
      "models": [{
        "id": "my-judge-model",
        "reasoning": true,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 8192
      }]
    }
  }
}
```

The token limits here are explicit execution budgets, not a claim about the
deployment's maximum capabilities. The definition permits one model and an
optional allowlisted HTTPS base URL; credentials, shell commands, custom
headers, and transport overrides are rejected. The SDK still uses its existing
provider transport. The registry is copied only into the verifier and its
contents are fingerprinted. This registers the requested model explicitly,
never substitutes a catalog model under another name, and does not change
ReviewBench's judge prompts or scoring code. Model availability and endpoint
compatibility still require an authenticated test. If pricing is omitted,
`byo-judge.json` marks it unavailable; SDK cost estimates must not be reported
as actual spending.

For an Anthropic model requiring adaptive thinking but missing from the locked
catalog, its explicit model definition may include
`"compat": { "forceAdaptiveThinking": true }`. Only that boolean compatibility
flag is accepted; arbitrary transport overrides remain rejected. The pinned SDK
supports this flag without changing the requested API model ID.

Explicit BYO options create `<kit>\dataset`, verify the source content digests,
and change only the judge configuration in that private copy. The PR snapshots,
goldens, reviewer instructions, and reviewer allowlist remain unchanged.
Changed judge settings receive new evaluation IDs, task digests, and a matching
metric; use **the kit's metric** when validating or comparing those runs.
`dataset/byo-judge.json` records the nonsecret judge policy. Existing prebuilt
images and noncanonical/private verifier entrypoints are rejected rather than
silently reusing the wrong judge.

Without BYO options, onboarding keeps its original reference-only behavior.
These scores are for self-funded tuning; official submissions still require
fresh maintainer-controlled execution with the official judge.

## Export

Requirements: Node 22+, `npm ci`, and a Debian-based Node container image pinned
by digest. Running tasks also requires Harbor, `uv` for its custom metric, and
a Linux sandbox. The local Harbor Docker orchestrator must run on Linux;
a Windows host with a Linux Docker daemon can build the images but Harbor
v0.24.0 rejects Docker allowlists from Windows. Do not disable network
enforcement to work around that rejection. Local Docker allowlists require the nftables features used by
Harbor's egress sidecar. The test suite uses Python 3; `PYTHON` can override its
executable.

Install the matching Harbor version, or install from the pinned source if your
package index does not yet contain it:

```powershell
uv tool install "harbor==0.24.0"
# Alternative:
uv tool install "git+https://github.com/harbor-framework/harbor.git@b53b8134e1241686dca7759af188f987ecc48e8b"
```

Resolve the current `node:22-bookworm-slim` digest with
`docker buildx imagetools inspect node:22-bookworm-slim`. Replace the placeholders
below with that digest and your exact judge model ID. The API key names and
hostnames shown here are for OpenAI; choose your provider's equivalents.

```powershell
npm run harbor:export -- --output .\.harbor\smoke --split test --limit 1 --judge-provider openai --judge-model "<judge-model-id>" --base-image "node:22-bookworm-slim@sha256:<digest>" --agent-host api.openai.com --judge-host api.openai.com --judge-env OPENAI_API_KEY=RB_HARBOR_JUDGE_KEY
```

Use `--organization <owned-hub-org>` when publishing outside `review-bench`.
Repeat `--agent-host`, `--judge-host`, or `--judge-env` for additional endpoints
or variables. `--judge-env` accepts **variable names, never values**, and requires
dedicated `RB_HARBOR_*` host variables to avoid ordinary agent auto-forwarding.
Provision these variables through your secret manager before running.

Remove `--limit` for the complete 25-task test set; use `--split full` for all
219 tasks. Outputs are respectively named `reviewbench-test` and `reviewbench`.
Limited exports have a `-smoke-N` suffix so they cannot accidentally replace the
full dataset package. Export into a new directory each time; existing output
is never overwritten.

The two splits use the same task names and digests when exported with identical
inputs/options. They can therefore reference the same Hub task packages.
Both read labels from canonical `golden` files, **not**
`corpus/test/findings.json`.

```text
export\
  dataset.toml
  metric.py
  <pr-key>\
    task.toml
    instruction.md
    environment\
      Dockerfile
      pr.json
    tests\
      Dockerfile
      test.sh
      task.json
      manifest.json
      golden\
      judge\
    solution\
      solve.sh
      findings.json
```

Tasks are immediate children of the export directory: Harbor's local resolver
and publisher discover them there. Task digests use Harbor's sorted
path/content-hash algorithm. The optional check below uses Harbor's own schemas
and packager (run it in an environment where Harbor is installed):

```powershell
python scripts\harbor\check-format.py .\.harbor\smoke
```

## Snapshots and isolation

Image builds fetch only the pinned base/head histories from the public
`review-bench/owner_repo` mirror. They check out HEAD, generate the three-dot
diff, and remove the Git remote. They do not fetch live PR branches, unrelated
refs, submodules, or LFS objects. Missing commits or merge bases fail the build.
Source licenses and notices remain in the snapshot; image redistribution still
requires the maintainer's licensing/privacy review.

The agent receives `/work/repo`, `/work/pr/pr.json`, `/work/pr/diff.patch`, and
the existing `RB_*` contract variables. The environment build context contains
no golden findings, oracle output, judge source, or judge credentials.

The separate verifier has its own freshly built snapshot and the locked judge
dependencies. Its image bakes in `/tests/test.sh`, as required for dedicated
Harbor verifier images. Only `/work/out/findings.json` is declared as a task
artifact. Harbor also transfers its standard artifact directory; the verifier
does not read or execute it.

The verifier validates the PR identity, regular-file output, paths, line ranges,
and findings before calling the existing strict CLI. A valid empty findings
array is scored; missing/malformed output fails. `--allow-empty` is used only
after the wrapper has established one valid, matching PR. `--snapshot-dir`
validates HEAD, base, merge base, and a clean tree (including ignored files);
it never fetches or clones. Golden files are removed after the judge loads them
into memory, and evaluation never uses `--ingest`.

Reviewer execution is limited to 900 seconds. The verifier budget defaults to
7,200 seconds, adjustable with `--verifier-timeout`; a timeout is not a zero
score. Both phases have explicit hostname allowlists. Agent installation uses
Harbor's public setup baseline, so this is not a claim of parity with the
official runner's proxy/port restrictions. Unsupported policies must fail,
not be silently weakened.

## CLI smoke run

On an approved Linux Docker runner, run the one-task export with a built-in reviewer:

```powershell
harbor run -p .\.harbor\smoke -a codex -m "openai/<reviewer-model-id>" -k 1 -n 1
```

The reviewer uses its ordinary provider credential; the verifier uses the
dedicated variable mapping from `task.toml`. The oracle checks output plumbing
with canonical TP findings:

```powershell
harbor run -p .\.harbor\smoke -a oracle -k 1 -n 1
```

**The oracle still invokes the real LLM judge and costs money.** It is not a
deterministic grading shortcut and need not receive a perfect score. The unit
tests instead check deterministic score parity and run a real empty-review
evaluation without credentials or inference.

Per-trial verifier logs retain `scores.json`, `scores.details.json`, the judge
fingerprints, and `reward.json`. The reward contains numeric sufficient counts,
including severity/category strata and task/evaluation identity markers.

## Aggregation

Use the exported dataset directory for local `-p` runs, not `dataset.toml`.
Harbor v0.24.0 does not automatically load a local directory's custom metric;
configure it explicitly in a job config:

```yaml
datasets:
  - path: .harbor/smoke
agents:
  - name: codex
    model_name: openai/<reviewer-model-id>
n_attempts: 1
n_concurrent_trials: 1
metrics:
  - type: uv-script
    kwargs:
      script_path: .harbor/smoke/metric.py
```

Run that configuration with `harbor run -c smoke.yaml`. Published Hub datasets
load their packaged `metric.py` automatically. Harbor's default mean of reward
fields is not a ReviewBench aggregate.

The metric reports `complete=0` with coverage/failure/duplicate counts during
incomplete runs and withholds all aggregate scores. Once every expected task
has one successful reward from the expected evaluation version, it reports
`complete=1`, macro averages, and pooled micro metrics. Undefined ratios have
`<metric>.defined=0` and no numeric value; the canonical per-PR JSON retains
`null`. Stratum names are URI-encoded in flat reward/metric keys.

For a release gate, pass a JSONL file containing one reward object or `null`
per trial through:

```powershell
python .\.harbor\smoke\metric.py -i rewards.jsonl -o metrics.json --require-complete
```

Also require **zero agent/trial exceptions in Harbor's job result**: the custom
metric receives rewards, not trial statuses, so it cannot detect an agent
failure if Harbor subsequently produced a valid verifier reward.

The release check validates both complete rewards and exception-free,
separate-verifier trial results in a downloaded or local job directory:

```powershell
python scripts\harbor\check-job.py .\.harbor\jobs\<job-name> .\.harbor\smoke\metric.py --output verified-metrics.json
```

CI runs `scripts.harbor.smoke_agent:EmptyReviewAgent` on a Linux Docker host.
It makes no inference calls, writes a valid empty review, checks that golden
and oracle assets and judge credentials are absent from the reviewer, and
requires blocked egress to a non-allowlisted hostname. The real judge then
grades the transferred artifact in a fresh verifier. This validates plumbing,
not real reviewer or authenticated judge performance.

Without the run plugin, use one attempt per task over the entire source export.
For subsets and repeated rounds, use the harness-independent plugin and native
controls described above. Do not mix independent jobs, pool attempts, or infer
the intended coverage from whichever trials happened to succeed.

## Private result upload

Keep the job directory's basename equal to `job_name` in `config.json`, including
when downloading artifacts from a remote runner. Harbor's whole-job downloader
expects that name at the archive root. Do not rename a job directory to `job`
before uploading. Re-uploading an already finalized job skips its existing
archive; it does not repair an incorrectly named archive.

After `check-job.py` succeeds, sign in and upload the job directory, not the
dataset export:

```powershell
harbor auth login
harbor upload .\.harbor\jobs\<job-name> --private
```

Use `--org <owned-hub-org>` to select the owner of a new upload. Keep trial
outputs, trajectories, and scoring provenance with the results, but never
upload credentials or private integration source. For a remote runner, inspect
and download its sanitized job artifacts, then upload from an authenticated
client; no Hub credential needs to be provisioned to the runner.

Result upload and dataset publication are separate actions. This adapter does
not automatically publish results, create leaderboard rows, or replace
ReviewBench's official submission process.

## Full benchmark execution

Obtain an approved **219-PR** export or a pinned Hub reference from the dataset
maintainer. Dataset access, inference access, and permission to publish are
separate. The chosen review harness must be compatible with the dataset's
reviewer image and endpoint policies; onboarding does not install a vendor
harness or relax those policies.

For a Hub dataset, download the approved version and verify its content before
generating a kit. The public standard dataset needs no sign-in; private profiles
require `harbor auth login` with an authorized account. This reference-only kit
example uses the public profile without changing its judge:

```powershell
$datasetRef = "review-bench/reviewbench-public@v1"
$datasetDir = ".\.harbor\hub\reviewbench-public"
harbor datasets download $datasetRef --output-dir .\.harbor\hub
python scripts\harbor\check-format.py $datasetDir --hub-ref $datasetRef
npm run harbor:onboard -- --dataset $datasetDir --output .\.harbor\full-kit --agent "<agent-name>" --model "<provider>/<reviewer-model>" --environment docker
$env:PYTHONPATH = (Get-Location).Path
harbor run -c .\.harbor\full-kit\job.json -p $datasetDir --plugin scripts.harbor.reviewbench_plugin:ReviewBenchPlugin -n 5 -k 3
```

For a local export with an existing manifest, omit the download and `--hub-ref`
restoration and validate it with `check-format.py <directory>`. If another judge
connection is needed, use the BYO options above with a clean canonical export,
not the already-versioned public profile. This creates new evaluation IDs
rather than silently changing the published judge policy.

Run on an approved Linux orchestrator or compatible cloud sandbox. Allocate
enough time, disk, model quota, and runner resources for the requested
`219*k` trials. A timeout, rate limit, missing review, or failed trial remains
a failure; it must not become a fabricated empty review or zero score.

After all selected tasks and rounds complete, validate the retained run metric,
then upload and validate the downloaded job again:

```powershell
python scripts\harbor\check-job.py .\.harbor\full-kit\jobs\reviewbench .\.harbor\full-kit\jobs\reviewbench\reviewbench-metric.py --output .\.harbor\full-kit\verified-metrics.json
harbor upload .\.harbor\full-kit\jobs\reviewbench --private --org "<approved-hub-org>"
harbor jobs download "<uploaded-job-id>" --output-dir .\.harbor\readback
python scripts\harbor\check-job.py .\.harbor\readback\reviewbench .\.harbor\readback\reviewbench\reviewbench-metric.py --output .\.harbor\readback\verified-metrics.json
```

For the three-round example, require `complete=1`,
`source_prs=expected_prs=219`, `n_attempts=completed_rounds=3`,
`expected_trials=scored_trials=657`, and zero trial exceptions or duplicates.
Record the dataset reference, evaluator version, reviewer version/model, and
the frozen plan. A one-PR smoke proves integration, not full-run completion.
Result upload is not public dataset release or official leaderboard acceptance.

## Optional hosted execution and dataset publication

### Model endpoints and credentials

Harbor does not host the review or judge model. Use an approved inference
provider's endpoint and its exact model identifier. The reviewer uses its
Harbor agent's provider/model configuration; the verifier uses the exported
`--judge-provider` and `--judge-model`. These are independent configurations.

The judge's locked SDK must recognize that exact provider/model pair.
An empty-review smoke test makes no model calls and therefore cannot prove
model availability or authentication. Do not guess an unregistered identifier or
treat a successful empty-review test as proof that an unregistered model works.

Harbor uses GitHub OAuth for sign-in but has separate organization memberships.
Confirm the owning namespace with `harbor auth org list`. In the Hub, select
that organization, open its Settings, and use **Add secret** for an approved
provider credential. Job `env` fields are plaintext configuration, not a place
for keys. Provider endpoint URLs and model IDs are nonsensitive configuration;
keys belong only in the secret manager.

For a local Anthropic judge, provision a dedicated `RB_HARBOR_JUDGE_KEY` through
your secret manager and export with
`--judge-env ANTHROPIC_API_KEY=RB_HARBOR_JUDGE_KEY` and
`--judge-host api.anthropic.com`. Give the reviewer a different credential.
No key values belong in exported files or images.

For hosted runs, normal agent secret selection grants those credentials to
the reviewer. **Do not select the judge key for the reviewer**, even under a
dedicated `RB_HARBOR_*` name. Confirm a verifier-only delivery route with the
deployed Hub before any authenticated judge trial. A literal, non-secret marker
in `[verifier.env]` can test phase isolation, but does not establish how stored
credentials are delivered. Hosted rollouts may require separate alpha-access
approval even when package publishing and organization ownership already work.

After local review, authenticate and publish a **private** smoke package:

```powershell
harbor auth login
harbor publish .\.harbor\smoke --private --tag v0.1.0
```

Hosted execution requires [Hub access](https://hub.harborframework.com/jobs/launch).
Select the published smoke dataset, a built-in agent/model, and one attempt in
the launcher. Export its job configuration to `smoke.yaml`, then:

```powershell
harbor run --launch -c .\smoke.yaml --dry-run
harbor run --launch -c .\smoke.yaml
```

**Do not launch until verifier-only secret routing is confirmed.** Local
`[verifier.env]` templates are isolated from the agent, but hosted secret
selection is per-agent; selecting the judge key for an agent may expose it.
Confirm with the deployed Hub that dedicated `RB_HARBOR_*` values resolve only
for the verifier. Never solve a routing failure by baking keys into images or
publishing literal secrets. The export alone is not an authenticated hosted
execution test.

Before public CLI release: exercise image builds, a real reviewer/judge trial,
network enforcement, phase-specific secret isolation, artifact transfer,
timeout/error handling, and score parity; archive the resulting image digests.
Hosted secret routing is an additional requirement only when offering the
optional hosted execution path. For repeatable
published runs, prebuild both images and pin their digests in `[environment]`
and `[verifier.environment]`, then run `harbor dataset sync` in the export
directory to refresh task digests. The base image and npm lock are pinned, but
apt repositories and image builds are not bit-for-bit reproducible.

Making a dataset public also exposes its referenced task versions, including
oracle and grading assets. Obtain publication/licensing approval first. These
runs remain experimental until ReviewBench explicitly accepts Harbor
submissions; no leaderboard rows are published automatically.

References: [task format](https://docs.harborframework.com/tasks/overview),
[separate verifier](https://docs.harborframework.com/tasks/separate-verifier),
[metrics](https://docs.harborframework.com/datasets/metrics),
[network policies](https://docs.harborframework.com/tasks/network-policies),
[cloud sandboxes](https://docs.harborframework.com/sandboxes/pre-integrated-sandboxes),
[result upload](https://docs.harborframework.com/harbor-hub/upload),
[publishing](https://docs.harborframework.com/harbor-hub/publish).
