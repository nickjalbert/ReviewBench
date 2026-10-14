import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { packageDigest } from "./export.js";
import type { VerifierTask } from "./verify.js";

export interface ByoJudgeOptions {
  provider: string;
  model: string;
  hosts: string[];
  env: Record<string, string>;
}

const API_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY", google: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY",
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function prepareByoJudge(dataset: string, options: ByoJudgeOptions): Map<string, string> {
  const apiKey = API_KEYS[options.provider];
  if (!apiKey) throw new Error("BYO judge requires a supported API-key provider");
  if (!ModelRegistry.inMemory(AuthStorage.inMemory()).find(options.provider, options.model)) {
    throw new Error(`Judge model is not registered in the locked SDK: ${options.provider}/${options.model}`);
  }
  if (!options.hosts.length || options.hosts.some(host =>
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(host))) {
    throw new Error("BYO judge requires exact endpoint hostnames, not URLs or wildcards");
  }
  if (!options.env[apiKey]) throw new Error(`Map ${apiKey} to a dedicated RB_HARBOR_* host variable`);
  for (const [key, variable] of Object.entries(options.env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || !/^RB_HARBOR_[A-Z0-9_]+$/.test(variable)) {
      throw new Error("Judge environment mappings must contain variable names, never credential values");
    }
  }
  const files = new Map<string, string>();
  function walk(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (entry.isFile()) files.set(relative, readFileSync(join(directory, entry.name), "utf8"));
      else throw new Error(`Refusing dataset symlink or special file: ${relative}`);
    }
  }
  walk(dataset);
  if (files.has("byo-judge.json")) throw new Error("Start from the canonical dataset, not an existing BYO profile");
  let manifest = files.get("dataset.toml");
  let metric = files.get("metric.py");
  if (!manifest || !metric) throw new Error("BYO judge requires an approved dataset manifest and metric");
  if (!manifest.includes(`path = "metric.py"\ndigest = "sha256:${sha(metric)}"`)) {
    throw new Error("Dataset metric content digest does not match its manifest");
  }
  const expectedLine = metric.match(/^EXPECTED_TASKS = (\{[^\r\n]*\})(?:[ \t]+#[^\r\n]*)?$/m);
  if (!expectedLine) throw new Error("Dataset metric has no expected task versions");
  const originalExpected: Record<string, number> = JSON.parse(expectedLine[1]);
  const expected: Record<string, number> = {};
  const policy = {
    provider: options.provider, model: options.model,
    hosts: [...options.hosts].sort(), env: Object.entries(options.env).sort(),
  };
  const fingerprint = sha(JSON.stringify(policy));
  const tasks = [...files.keys()].filter(path => /^[^/]+\/task.toml$/.test(path));
  if (!tasks.length) throw new Error("BYO judge dataset has no tasks");
  const taskDirectories = new Set(tasks.map(path => path.split("/")[0]));
  for (const path of files.keys()) {
    if (path !== "dataset.toml" && path !== "metric.py" && !taskDirectories.has(path.split("/")[0])) {
      throw new Error(`Unexpected dataset asset; refusing to copy it into the kit: ${path}`);
    }
  }
  for (const path of tasks) {
    const key = path.split("/")[0];
    const taskPath = `${key}/tests/task.json`;
    const task: VerifierTask = JSON.parse(files.get(taskPath) ?? "");
    if (!Number.isSafeInteger(task.task_id) || !Number.isSafeInteger(task.evaluation_id) ||
        originalExpected[String(task.task_id)] !== task.evaluation_id) {
      throw new Error(`Dataset task identity/version mismatch: ${key}`);
    }
    if (files.get(`${key}/tests/test.sh`) !==
        "#!/bin/bash\nset -euo pipefail\ncd /tests/judge\nexec node --import tsx scripts/harbor/verify.ts /tests/task.json\n") {
      throw new Error(`BYO judge requires the canonical verifier, not a private transport: ${key}`);
    }
    let toml = files.get(path)!;
    const taskName = toml.match(/\[task\]\nname = ("[^"]+")/);
    if (!taskName) throw new Error(`Missing task package name: ${key}`);
    const reference = `name = ${taskName[1]}`;
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(${escaped}\\ndigest = ")sha256:[a-f0-9]{64}"`);
    const originalFiles = new Map([...files].filter(([path]) => path.startsWith(`${key}/`))
      .map(([path, value]) => [path.slice(key.length + 1), value]));
    if (!manifest.includes(`${reference}\ndigest = "sha256:${packageDigest(originalFiles)}"`)) {
      throw new Error(`Dataset task content digest does not match its manifest: ${key}`);
    }
    if (/^docker_image\s*=/m.test(toml)) {
      throw new Error("BYO judge requires rebuildable verifier images, not a prebuilt judge image");
    }
    for (const section of ["verifier", "verifier.env", "verifier.environment"]) {
      if (!toml.includes(`[${section}]\n`)) throw new Error(`Missing separate verifier configuration: ${key}`);
    }
    if (!toml.includes('environment_mode = "separate"')) {
      throw new Error(`BYO judge requires a separate verifier: ${key}`);
    }
    toml = toml.replace(/^judge_provider = .+$/m, `judge_provider = ${JSON.stringify(options.provider)}`)
      .replace(/^judge_model = .+$/m, `judge_model = ${JSON.stringify(options.model)}`)
      .replace("[environment]", `byo_judge_sha256 = "${fingerprint}"\n\n[environment]`);
    for (const section of ["verifier", "verifier.environment"]) {
      const pattern = new RegExp(`(\\[${section.replace(".", "\\.")}\\]\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
      toml = toml.replace(pattern, (_match, header: string, body: string) => {
        if (!body.includes('network_mode = "allowlist"') || !/^allowed_hosts = .+$/m.test(body)) {
          throw new Error(`BYO judge requires explicit verifier allowlists: ${key}`);
        }
        return header + body.replace(/^allowed_hosts = .+$/m, `allowed_hosts = ${JSON.stringify(policy.hosts)}`);
      });
    }
    toml = toml.replace(/\[verifier\.env\]\n[\s\S]*?(?=\n\[|$)/,
      "[verifier.env]\n" + policy.env.map(([key, variable]) =>
        `${key} = ${JSON.stringify(`\${${variable}}`)}`).join("\n") + "\n");
    task.provider = options.provider;
    task.model = options.model;
    task.evaluation_id = Number.parseInt(sha(`${task.evaluation_id}\0byo-judge-v1\0${fingerprint}`).slice(0, 13), 16);
    if (String(task.task_id) in expected) throw new Error("Duplicate BYO task identity");
    expected[String(task.task_id)] = task.evaluation_id;
    files.set(path, toml);
    files.set(taskPath, JSON.stringify(task) + "\n");
    const taskFiles = new Map([...files].filter(([path]) => path.startsWith(`${key}/`))
      .map(([path, value]) => [path.slice(key.length + 1), value]));
    if (!pattern.test(manifest)) throw new Error(`Missing canonical dataset task reference: ${key}`);
    manifest = manifest.replace(pattern, `$1sha256:${packageDigest(taskFiles)}"`);
  }
  if (Object.keys(originalExpected).length !== tasks.length) throw new Error("Incomplete dataset task coverage");
  metric = metric.replace(/^EXPECTED_TASKS = .+$/m, `EXPECTED_TASKS = ${JSON.stringify(expected)}`);
  manifest = manifest.replace(/(\[dataset\]\nname = ")([^"]+)"/, "$1$2-byo\"")
    .replace(/(path = "metric.py"\ndigest = ")sha256:[a-f0-9]{64}"/, `$1sha256:${sha(metric)}"`);
  files.set("metric.py", metric);
  files.set("dataset.toml", manifest);
  files.set("byo-judge.json", JSON.stringify({
    schema_version: 1, ...policy, fingerprint, task_count: tasks.length,
    contains_credentials: false, official_submission: false,
  }, null, 2) + "\n");
  return files;
}
