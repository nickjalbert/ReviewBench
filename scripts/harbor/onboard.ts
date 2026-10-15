import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareByoJudge, type ByoJudgeOptions } from "./byo-judge.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface OnboardingOptions {
  dataset: string;
  output: string;
  agent?: string;
  model?: string;
  customAgent?: boolean;
  environment: "docker" | "daytona" | "modal" | "e2b";
  judge?: ByoJudgeOptions;
}

export function createOnboardingKit(opts: OnboardingOptions, root = ROOT): void {
  const dataset = resolve(opts.dataset);
  const output = resolve(opts.output);
  if (existsSync(output)) throw new Error("Output already exists; choose a new kit directory");
  const outputRelative = relative(dataset, output);
  if (opts.judge && !isAbsolute(outputRelative) && outputRelative.split(sep)[0] !== "..") {
    throw new Error("BYO kit output must be outside the source dataset");
  }
  if (!existsSync(join(dataset, "dataset.toml")) || !existsSync(join(dataset, "metric.py"))) {
    throw new Error("Use an approved ReviewBench export containing dataset.toml and metric.py");
  }
  const tasks = readdirSync(dataset, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory() && existsSync(join(dataset, entry.name, "task.toml")));
  if (!tasks.length) throw new Error("The approved dataset has no tasks");
  if (opts.customAgent ? Boolean(opts.agent) : !opts.agent) {
    throw new Error("Select either --agent or --custom-agent");
  }
  if (opts.agent && !/^[a-z][a-z0-9-]*$/.test(opts.agent)) {
    throw new Error("Built-in agent name must contain lowercase letters, digits, and hyphens");
  }
  if (opts.agent && !opts.model) throw new Error("Specify the reviewer --model as provider/model");
  if (opts.model !== undefined && !/^[^\s/]+\/[^\s]+$/.test(opts.model)) {
    throw new Error("Reviewer model must be provider/model");
  }
  if (!["docker", "daytona", "modal", "e2b"].includes(opts.environment)) {
    throw new Error("Select a supported environment: docker, daytona, modal, or e2b");
  }
  const judgeFiles = opts.judge ? prepareByoJudge(dataset, opts.judge) : undefined;
  const runDataset = judgeFiles ? join(output, "dataset") : dataset;
  const agent = {
    ...(opts.customAgent ? { import_path: "custom_agent:CustomReviewAgent" } : { name: opts.agent }),
    ...(opts.model ? { model_name: opts.model } : {}),
  };
  const config = {
    job_name: "reviewbench",
    jobs_dir: join(output, "jobs"),
    datasets: [{ path: runDataset }],
    agents: [agent],
    environment: { type: opts.environment },
    n_attempts: 1,
    n_concurrent_trials: 1,
    metrics: [{ type: "uv-script", kwargs: { script_path: join(runDataset, "metric.py") } }],
  };
  const readme = readFileSync(join(root, "scripts", "harbor", "onboarding", "README.md"), "utf8");
  const adapter = readFileSync(join(root, "scripts", "harbor", "onboarding", "custom_agent.py"), "utf8");
  mkdirSync(output, { recursive: true });
  for (const [relative, contents] of judgeFiles ?? []) {
    const destination = join(runDataset, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents, { mode: relative.endsWith(".sh") ? 0o755 : 0o644 });
  }
  writeFileSync(join(output, "job.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(output, "custom_agent.py"), adapter);
  writeFileSync(join(output, "README.md"), readme);
  writeFileSync(join(output, "kit.json"), JSON.stringify({
    schema_version: 1,
    dataset: runDataset,
    task_count: tasks.length,
    agent,
    environment: opts.environment,
    changes_judge_or_tasks: Boolean(judgeFiles),
    ...(judgeFiles ? { source_dataset: dataset, judge: opts.judge, official_submission: false } : {}),
    contains_credentials: false,
  }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      dataset: { type: "string" }, output: { type: "string" },
      agent: { type: "string" }, model: { type: "string" },
      "custom-agent": { type: "boolean", default: false },
      environment: { type: "string", default: "docker" },
      "judge-provider": { type: "string" }, "judge-model": { type: "string" },
      "judge-host": { type: "string", multiple: true },
      "judge-env": { type: "string", multiple: true },
      "judge-model-config": { type: "string" },
      "judge-setting": { type: "string", multiple: true },
    } });
    if (!values.dataset || !values.output) throw new Error("--dataset and --output are required");
    const environment = values.environment;
    if (environment !== "docker" && environment !== "daytona" &&
        environment !== "modal" && environment !== "e2b") {
      throw new Error("--environment must be docker, daytona, modal, or e2b");
    }
    const byo = values["judge-provider"] || values["judge-model"] ||
      values["judge-host"] || values["judge-env"] || values["judge-model-config"] || values["judge-setting"];
    let judge: ByoJudgeOptions | undefined;
    if (byo) {
      if (!values["judge-provider"] || !values["judge-model"]) {
        throw new Error("BYO judge requires --judge-provider and --judge-model");
      }
      const env: Record<string, string> = {};
      for (const mapping of values["judge-env"] ?? []) {
        const parts = mapping.split("=");
        if (parts.length !== 2 || parts[0] in env) throw new Error("Invalid or duplicate --judge-env mapping");
        env[parts[0]] = parts[1];
      }
      const settings: Record<string, string> = {};
      for (const setting of values["judge-setting"] ?? []) {
        const separator = setting.indexOf("=");
        const key = setting.slice(0, separator);
        if (separator < 1 || key in settings) throw new Error("Invalid or duplicate --judge-setting");
        settings[key] = setting.slice(separator + 1);
      }
      judge = {
        provider: values["judge-provider"], model: values["judge-model"],
        hosts: values["judge-host"] ?? [], env,
        ...(values["judge-model-config"] ? { modelConfig: resolve(values["judge-model-config"]) } : {}),
        ...(Object.keys(settings).length ? { settings } : {}),
      };
    }
    createOnboardingKit({
      dataset: values.dataset, output: values.output, agent: values.agent, model: values.model,
      customAgent: values["custom-agent"],
      environment,
      judge,
    });
    console.log(`Created user kit at ${resolve(values.output)}. No credentials included.${judge ? " Private BYO judge dataset created; not an official score." : " No dataset assets copied."}`);
  } catch (error) {
    console.error("Harbor onboarding failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
