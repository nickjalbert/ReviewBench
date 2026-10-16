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
  modelConfig?: string;
  settings?: Record<string, string>;
}

const API_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY", google: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY",
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function endpoint(value: string, hosts: string[]): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== "443") || !hosts.includes(url.hostname)) {
    throw new Error("Judge base URL must be HTTPS on an allowlisted host without credentials or query parameters");
  }
}

function modelConfiguration(options: ByoJudgeOptions): { text?: string; pricingAvailable: boolean } {
  if (!options.modelConfig) return { pricingAvailable: true };
  const raw: unknown = JSON.parse(readFileSync(options.modelConfig, "utf8"));
  if (!isRecord(raw) || Object.keys(raw).some(key => key !== "providers") || !isRecord(raw.providers) ||
      Object.keys(raw.providers).length !== 1) {
    throw new Error("Judge model config must declare only the selected provider");
  }
  const provider = raw.providers[options.provider];
  if (!isRecord(provider) || Object.keys(provider).some(key => !["models", "baseUrl"].includes(key)) ||
      !Array.isArray(provider.models) || provider.models.length !== 1 || !isRecord(provider.models[0])) {
    throw new Error("Judge model config permits one model and an optional baseUrl, not credentials, commands or transport overrides");
  }
  if (provider.baseUrl !== undefined) {
    if (typeof provider.baseUrl !== "string") throw new Error("Judge baseUrl must be a string");
    endpoint(provider.baseUrl, options.hosts);
  }
  if (options.provider === "azure-openai-responses" && !provider.baseUrl) {
    throw new Error("Custom Azure judge models require an explicit allowlisted baseUrl");
  }
  const model = provider.models[0];
  const allowed = ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap", "compat"];
  if (model.id !== options.model || Object.keys(model).some(key => !allowed.includes(key))) {
    throw new Error("Judge model definition must match the requested model and cannot override authentication or transport");
  }
  if (model.compat !== undefined && (
    options.provider !== "anthropic" || !isRecord(model.compat) ||
    Object.keys(model.compat).some(key => key !== "forceAdaptiveThinking") ||
    typeof model.compat.forceAdaptiveThinking !== "boolean"
  )) {
    throw new Error("Judge compatibility permits only Anthropic forceAdaptiveThinking, not transport overrides");
  }
  const contextWindow = model.contextWindow;
  const maxTokens = model.maxTokens;
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1 ||
      typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error("Judge model config requires explicit positive context and output budgets");
  }
  if (maxTokens > contextWindow) {
    throw new Error("Judge output budget exceeds its context budget");
  }
  if (model.cost !== undefined && (!isRecord(model.cost) ||
      Object.keys(model.cost).some(key => !["input", "output", "cacheRead", "cacheWrite"].includes(key)) ||
      ["input", "output", "cacheRead", "cacheWrite"].some(key =>
        !isRecord(model.cost) || typeof model.cost[key] !== "number" ||
        !Number.isFinite(model.cost[key]) || model.cost[key] < 0))) {
    throw new Error("Judge model pricing must contain four finite nonnegative rates");
  }
  return { text: JSON.stringify(raw) + "\n", pricingAvailable: model.cost !== undefined };
}

export function prepareByoJudge(dataset: string, options: ByoJudgeOptions): Map<string, string> {
  const apiKey = API_KEYS[options.provider];
  if (!apiKey) throw new Error("BYO judge requires a supported API-key provider");
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
  const settings = options.settings ?? {};
  for (const [key, value] of Object.entries(settings)) {
    if (options.provider !== "azure-openai-responses" || key in options.env ||
        !["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP"].includes(key)) {
      throw new Error("Only dedicated nonsecret Azure endpoint, API version and deployment settings are supported");
    }
    if (key === "AZURE_OPENAI_BASE_URL") endpoint(value, options.hosts);
    if (key === "AZURE_OPENAI_API_VERSION" && !/^[a-z0-9.-]+$/.test(value)) {
      throw new Error("Invalid Azure API version");
    }
    if (key === "AZURE_OPENAI_DEPLOYMENT_NAME_MAP") {
      const [model, deployment, extra] = value.split("=");
      if (model !== options.model || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deployment ?? "") || extra !== undefined) {
        throw new Error("Azure deployment mapping must explicitly map the requested model to one deployment");
      }
    }
  }
  const modelConfig = modelConfiguration(options);
  if (modelConfig.text && "PI_CODING_AGENT_DIR" in options.env) {
    throw new Error("Custom judge model registry owns PI_CODING_AGENT_DIR");
  }
  const registry = options.modelConfig
    ? ModelRegistry.create(AuthStorage.inMemory(), options.modelConfig)
    : ModelRegistry.inMemory(AuthStorage.inMemory());
  if (registry.getError()) throw new Error(`Invalid judge model config: ${registry.getError()}`);
  if (!registry.find(options.provider, options.model)) {
    throw new Error(`Judge model is not registered in the locked SDK: ${options.provider}/${options.model}`);
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
    ...(Object.keys(settings).length ? { settings: Object.entries(settings).sort() } : {}),
    ...(modelConfig.text ? { model_registry_sha256: sha(modelConfig.text) } : {}),
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
    const verifierEnv = [
      ...policy.env.map(([key, variable]) => `${key} = ${JSON.stringify(`\${${variable}}`)}`),
      ...Object.entries(settings).sort().map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
      ...(modelConfig.text ? ['PI_CODING_AGENT_DIR = "/tests/judge/.reviewbench-byo"'] : []),
    ];
    toml = toml.replace(/\[verifier\.env\]\n[\s\S]*?(?=\n\[|$)/,
      "[verifier.env]\n" + verifierEnv.join("\n") + "\n");
    task.provider = options.provider;
    task.model = options.model;
    task.evaluation_id = Number.parseInt(sha(`${task.evaluation_id}\0byo-judge-v1\0${fingerprint}`).slice(0, 13), 16);
    if (String(task.task_id) in expected) throw new Error("Duplicate BYO task identity");
    expected[String(task.task_id)] = task.evaluation_id;
    files.set(path, toml);
    files.set(taskPath, JSON.stringify(task) + "\n");
    if (modelConfig.text) files.set(`${key}/tests/judge/.reviewbench-byo/models.json`, modelConfig.text);
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
    judge_pricing_available: modelConfig.pricingAvailable,
  }, null, 2) + "\n");
  return files;
}
