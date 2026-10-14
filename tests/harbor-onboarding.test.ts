import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { createOnboardingKit } from "../scripts/harbor/onboard.js";
import { exportDataset, packageDigest } from "../scripts/harbor/export.js";
import { prepareByoJudge } from "../scripts/harbor/byo-judge.js";
import { validateFindings } from "../scripts/harbor/validate-findings.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "reviewbench-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataset = join(root, "dataset");
  mkdirSync(join(dataset, "one-pr"), { recursive: true });
  writeFileSync(join(dataset, "dataset.toml"), "[dataset]\n");
  writeFileSync(join(dataset, "metric.py"), "EXPECTED_TASKS = {}\n");
  writeFileSync(join(dataset, "one-pr", "task.toml"), "[task]\n");
  const pr = {
    repo: "https://github.com/example/repo", pr_number: 1,
    base: "a".repeat(40), head: "b".repeat(40),
  };
  const prPath = join(root, "pr.json");
  writeFileSync(prPath, JSON.stringify(pr));
  return { root, dataset, output: join(root, "kit"), pr, prPath };
}

test("onboarding emits a model-independent job with the approved metric and no copied task assets", (t) => {
  const f = fixture(t);
  const original = readFileSync(join(f.dataset, "one-pr", "task.toml"), "utf8");
  createOnboardingKit({
    dataset: f.dataset, output: f.output,
    agent: "codex", model: "example/reviewer-model", environment: "docker",
  });
  const job = JSON.parse(readFileSync(join(f.output, "job.json"), "utf8"));
  assert.deepEqual(job.agents, [{ name: "codex", model_name: "example/reviewer-model" }]);
  assert.deepEqual(job.datasets, [{ path: resolve(f.dataset) }]);
  assert.equal(job.metrics[0].type, "uv-script");
  assert.equal(job.metrics[0].kwargs.script_path, join(f.dataset, "metric.py"));
  assert.equal(job.n_attempts, 1);
  assert.equal(job.n_concurrent_trials, 1);
  assert.equal(job.environment.type, "docker");
  assert.equal("env" in job.agents[0], false);
  assert.equal("verifier" in job, false);
  assert.deepEqual(readdirSync(f.output).sort(), ["README.md", "custom_agent.py", "job.json", "kit.json"]);
  assert.equal(readFileSync(join(f.dataset, "one-pr", "task.toml"), "utf8"), original);
});

test("custom harness kit uses an importable adapter and fails explicitly until implemented", (t) => {
  const f = fixture(t);
  createOnboardingKit({
    dataset: f.dataset, output: f.output, customAgent: true, environment: "daytona",
  });
  const job = JSON.parse(readFileSync(join(f.output, "job.json"), "utf8"));
  assert.deepEqual(job.agents, [{ import_path: "custom_agent:CustomReviewAgent" }]);
  assert.equal(job.environment.type, "daytona");
  const adapter = readFileSync(join(f.output, "custom_agent.py"), "utf8");
  assert.match(adapter, /raise NotImplementedError/);
  assert.match(adapter, /shlex\.join\(arguments\)/);
  assert.match(adapter, /result\.return_code != 0/);
  assert.match(adapter, /\/work\/out\/findings\.json/);
});

  function byoFixture(t: TestContext) {
    const f = fixture(t);
    const approved = join(f.root, "approved");
    exportDataset({
      output: approved, organization: "review-bench", split: "test", limit: 1,
      provider: "github-copilot", model: "claude-sonnet-5",
      baseImage: `node:22-bookworm-slim@sha256:${"a".repeat(64)}`,
      agentHosts: ["reviewer.example.com"], judgeHosts: ["api.githubcopilot.com"],
      judgeEnv: { CAPI_DEV_KEY: "RB_HARBOR_CAPI_KEY" }, verifierTimeout: 7200,
    });
    const judge = {
      provider: "anthropic", model: "claude-sonnet-4-6",
      hosts: ["api.anthropic.com"], env: { ANTHROPIC_API_KEY: "RB_HARBOR_JUDGE_KEY" },
    };
    return { ...f, approved, judge };
  }

  test("BYO onboarding creates a private versioned judge profile without changing the source or reviewer", (t) => {
    const f = byoFixture(t);
    const key = readdirSync(f.approved).find(name => existsSync(join(f.approved, name, "task.toml")))!;
    const originalToml = readFileSync(join(f.approved, key, "task.toml"), "utf8");
    const originalTask = JSON.parse(readFileSync(join(f.approved, key, "tests", "task.json"), "utf8"));
    createOnboardingKit({
      dataset: f.approved, output: f.output, agent: "codex",
      model: "example/reviewer", environment: "docker", judge: f.judge,
    });
    const dataset = join(f.output, "dataset");
    const job = JSON.parse(readFileSync(join(f.output, "job.json"), "utf8"));
    assert.deepEqual(job.datasets, [{ path: dataset }]);
    assert.deepEqual(job.agents, [{ name: "codex", model_name: "example/reviewer" }]);
    assert.equal(job.metrics[0].kwargs.script_path, join(dataset, "metric.py"));
    const task = JSON.parse(readFileSync(join(dataset, key, "tests", "task.json"), "utf8"));
    assert.equal(task.task_id, originalTask.task_id);
    assert.notEqual(task.evaluation_id, originalTask.evaluation_id);
    assert.equal(task.provider, "anthropic");
    assert.equal(task.model, "claude-sonnet-4-6");
    const toml = readFileSync(join(dataset, key, "task.toml"), "utf8");
    assert.match(toml, /ANTHROPIC_API_KEY = "\$\{RB_HARBOR_JUDGE_KEY\}"/);
    assert.equal(toml.includes("CAPI_DEV_KEY"), false);
    assert.match(toml, /\[agent\][\s\S]*allowed_hosts = \["reviewer.example.com"\]/);
    assert.equal(toml.match(/allowed_hosts = \["api.anthropic.com"\]/g)?.length, 2);
    assert.match(toml, /environment_mode = "separate"/);
    assert.equal(readFileSync(join(f.approved, key, "task.toml"), "utf8"), originalToml);
    const metric = readFileSync(join(dataset, "metric.py"), "utf8");
    assert.match(metric, new RegExp(`"${task.task_id}":${task.evaluation_id}`));
    const files = prepareByoJudge(f.approved, f.judge);
    const taskFiles = new Map([...files].filter(([path]) => path.startsWith(`${key}/`))
      .map(([path, contents]) => [path.slice(key.length + 1), contents]));
    assert.ok(files.get("dataset.toml")!.includes(`digest = "sha256:${packageDigest(taskFiles)}"`));
    assert.match(files.get("dataset.toml")!, /reviewbench-test-smoke-1-byo/);
    assert.equal(JSON.parse(files.get("byo-judge.json")!).official_submission, false);
    assert.deepEqual(prepareByoJudge(f.approved, f.judge), files);
    const different = prepareByoJudge(f.approved, { ...f.judge, model: "claude-sonnet-4-5" });
    assert.notEqual(JSON.parse(different.get(`${key}/tests/task.json`)!).evaluation_id, task.evaluation_id);
  });

  test("BYO judge rejects unregistered models, credential values, incomplete mappings and unsafe hosts before writing", (t) => {
    const f = byoFixture(t);
    for (const judge of [
      { ...f.judge, model: "claude-sonnet-5-not-registered" },
      { ...f.judge, provider: "github-copilot" },
      { ...f.judge, env: {} },
      { ...f.judge, env: { ANTHROPIC_API_KEY: "sk-actual-key-value" } },
      { ...f.judge, hosts: ["https://api.anthropic.com"] },
      { ...f.judge, hosts: ["*.anthropic.com"] },
    ]) {
      assert.throws(() => createOnboardingKit({
        dataset: f.approved, output: f.output, agent: "codex",
        model: "example/reviewer", environment: "docker", judge,
      }));
      assert.equal(existsSync(f.output), false);
    }
  });

  test("BYO judge refuses private verifier overrides and mismatched task identities", (t) => {
    const f = byoFixture(t);
    const key = readdirSync(f.approved).find(name => existsSync(join(f.approved, name, "task.toml")))!;
    const script = join(f.approved, key, "tests", "test.sh");
    const original = readFileSync(script, "utf8");
    writeFileSync(script, "exec node private-capi-wrapper.ts\n");
    assert.throws(() => prepareByoJudge(f.approved, f.judge), /canonical verifier/);
    writeFileSync(script, original);
    const path = join(f.approved, key, "tests", "task.json");
    const task = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...task, evaluation_id: task.evaluation_id + 1 }));
    assert.throws(() => prepareByoJudge(f.approved, f.judge), /identity\/version mismatch/);
  });

  test("BYO judge rejects a modified metric or task instead of trusting stale content digests", (t) => {
    const f = byoFixture(t);
    const metric = join(f.approved, "metric.py");
    const original = readFileSync(metric, "utf8");
    writeFileSync(metric, original + "\n# modified\n");
    assert.throws(() => prepareByoJudge(f.approved, f.judge), /metric content digest/);
    writeFileSync(metric, original);
    const key = readdirSync(f.approved).find(name => existsSync(join(f.approved, name, "task.toml")))!;
    const instruction = join(f.approved, key, "instruction.md");
    writeFileSync(instruction, readFileSync(instruction, "utf8") + "\nModified instruction\n");
    assert.throws(() => prepareByoJudge(f.approved, f.judge), /task content digest/);
  });
test("onboarding rejects incomplete or ambiguous configuration without creating output", (t) => {
  const f = fixture(t);
  const base = { dataset: f.dataset, output: f.output, environment: "docker" as const };
  for (const bad of [
    base,
    { ...base, agent: "codex" },
    { ...base, agent: "codex", customAgent: true, model: "example/model" },
    { ...base, agent: "codex", model: "bare-model" },
    { ...base, agent: "codex;echo", model: "example/model" },
  ]) {
    assert.throws(() => createOnboardingKit(bad));
    assert.equal(existsSync(f.output), false);
  }
  createOnboardingKit({ ...base, agent: "codex", model: "example/model" });
  assert.throws(() => createOnboardingKit({ ...base, agent: "codex", model: "example/model" }), /already exists/);
});

test("onboarding rejects a missing approved export and unsupported sandbox", (t) => {
  const f = fixture(t);
  assert.throws(() => createOnboardingKit({
    dataset: f.root, output: f.output, agent: "codex", model: "example/model", environment: "docker",
  }), /approved ReviewBench export/);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "scripts/harbor/onboard.ts",
    "--dataset", f.dataset, "--output", f.output,
    "--agent", "codex", "--model", "example/model", "--environment", "unsupported",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /environment must be/);
  assert.equal(existsSync(f.output), false);
});

test("BYO CLI rejects partial flags and duplicate environment mappings without creating a kit", (t) => {
  const f = byoFixture(t);
  const base = [
    "--import", "tsx", "scripts/harbor/onboard.ts",
    "--dataset", f.approved, "--output", f.output,
    "--agent", "codex", "--model", "example/reviewer",
  ];
  for (const options of [
    ["--judge-provider", "anthropic"],
    ["--judge-model", "claude-sonnet-4-6"],
    ["--judge-host", "api.anthropic.com"],
    ["--judge-env", "ANTHROPIC_API_KEY=RB_HARBOR_JUDGE_KEY"],
    ["--judge-provider", "anthropic", "--judge-model", "claude-sonnet-4-6",
      "--judge-env", "ANTHROPIC_API_KEY=RB_HARBOR_JUDGE_KEY",
      "--judge-env", "ANTHROPIC_API_KEY=RB_HARBOR_OTHER_KEY"],
  ]) {
    const result = spawnSync(process.execPath, [...base, ...options], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Harbor onboarding failed:/);
    assert.equal(existsSync(f.output), false);
  }
});

test("BYO judge refuses uncatalogued files rather than copying them into the kit", (t) => {
  const f = byoFixture(t);
  writeFileSync(join(f.approved, "unlisted.txt"), "An unrelated file\n");
  assert.throws(() => createOnboardingKit({
    dataset: f.approved, output: f.output, agent: "codex",
    model: "example/reviewer", environment: "docker", judge: f.judge,
  }), /Unexpected dataset asset/);
  assert.equal(existsSync(f.output), false);
});

test("BYO onboarding cannot write its output inside the source dataset", (t) => {
  const f = byoFixture(t);
  const output = join(f.approved, "nested-kit");
  assert.throws(() => createOnboardingKit({
    dataset: f.approved, output, agent: "codex",
    model: "example/reviewer", environment: "docker", judge: f.judge,
  }), /outside the source dataset/);
  assert.equal(existsSync(output), false);
});

test("standalone validator accepts valid and empty findings, rejects identity and format errors", (t) => {
  const f = fixture(t);
  const path = join(f.root, "findings.json");
  const finding = { producer: "my-agent", file: "src/a.ts", start_line: 1, end_line: 2, message: "An issue." };
  function write(value: unknown) { writeFileSync(path, JSON.stringify(value)); }
  for (const findings of [[], [finding]]) {
    write({ pr: f.pr, agent: "my-agent", findings });
    assert.doesNotThrow(() => validateFindings(path, f.prPath));
  }
  for (const bad of [
    { pr: { ...f.pr, head: "c".repeat(40) }, agent: "my-agent", findings: [finding] },
    { pr: f.pr, agent: "", findings: [finding] },
    ...[
      { file: "../a.ts" }, { file: "C:\\a.ts" }, { start_line: 0 },
      { start_line: "1" }, { end_line: 0 }, { message: "" }, { producer: "" },
    ].map(change => ({ pr: f.pr, agent: "my-agent", findings: [{ ...finding, ...change }] })),
  ]) {
    write(bad);
    assert.throws(() => validateFindings(path, f.prPath));
  }
  writeFileSync(path, "{not json");
  assert.throws(() => validateFindings(path, f.prPath));
  writeFileSync(f.prPath, JSON.stringify({ ...f.pr, head: "invalid" }));
  assert.throws(() => validateFindings(path, f.prPath), /PR metadata/);
});

test("validator CLI explicitly reports success and fails malformed output", (t) => {
  const f = fixture(t);
  const path = join(f.root, "findings.json");
  writeFileSync(path, JSON.stringify({ pr: f.pr, agent: "my-agent", findings: [] }));
  const args = [
    "--import", "tsx", "scripts/harbor/validate-findings.ts",
    "--candidate", path, "--pr", f.prPath,
  ];
  const valid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /No judging or inference performed/);
  writeFileSync(path, "{}");
  const invalid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Findings validation failed/);
});
