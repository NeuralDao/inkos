#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_CODE_BASE = "ee4c57e496db561b3d0ad9675d604a886e950941";
const ALLOWED_MODELS = new Set([
  "nvidia/nemotron-3.5-super-vl:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "cohere/north-mini-code:free",
]);
const STAGES = [
  "submit_foundation_outline",
  "submit_foundation_details",
  "submit_foundation_cast_index",
  "submit_foundation_cast_documents",
];
const PROTECTED_PATHS = [
  "packages/core/src",
  "packages/core/package.json",
  "packages/core/tsconfig.json",
  "tsconfig.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "scripts/clean-package-dist.mjs",
];
const LANGUAGE_CONTRACT_WARNING =
  "ArchitectAgent.generateFoundation currently selects its prompt language from BookConfig.language and explicitly requests English when language='en'; it does not use narrativeLanguage. With the benchmark's language='en', narrativeLanguage='ru' pair, this run can validate the four-stage pipeline but cannot qualify Russian foundation prose.";

function usage() {
  return [
    "G1 full Architect foundation smoke",
    "",
    "Required:",
    "  --repo-root <path>       Local NeuralDao/inkos checkout (default: cwd)",
    "  --project-root <path>    Studio workspace containing inkos.json",
    "  --model <exact-free-id>  One of the three qualified fixed IDs",
    "",
    "Optional:",
    "  --output <path>          Write JSON report outside repo/workspace; otherwise stdout",
    "  --run                    Perform one live Architect.generateFoundation call",
    "  --confirm-live-llm       Required together with --run",
    "  --dry-run                Preflight only (default)",
    "  --help",
    "",
    "The default mode performs no LLM API calls. No Work or Foundation files are created.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    repoRoot: process.cwd(),
    projectRoot: "",
    model: "",
    output: "",
    run: false,
    confirmLive: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--run") {
      args.run = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.run = false;
      continue;
    }
    if (arg === "--confirm-live-llm") {
      args.confirmLive = true;
      continue;
    }
    const valueOptions = new Map([
      ["--repo-root", "repoRoot"],
      ["--project-root", "projectRoot"],
      ["--model", "model"],
      ["--output", "output"],
    ]);
    const key = valueOptions.get(arg);
    if (!key) throw new Error("Unknown argument: " + arg);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg);
    args[key] = value;
    index += 1;
  }
  if (args.help) return args;
  if (!args.projectRoot) throw new Error("--project-root is required.");
  if (!args.model) throw new Error("--model is required.");
  if (!ALLOWED_MODELS.has(args.model)) {
    throw new Error("Model is not in the approved G1 allowlist: " + args.model);
  }
  if (args.run && !args.confirmLive) {
    throw new Error("Live calls require both --run and --confirm-live-llm.");
  }
  if (!args.run && args.confirmLive) {
    throw new Error("--confirm-live-llm is only valid together with --run.");
  }
  args.repoRoot = resolve(args.repoRoot);
  args.projectRoot = resolve(args.projectRoot);
  if (args.output) args.output = resolve(args.output);
  return args;
}

function git(repoRoot, gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertGitCommand(repoRoot, gitArgs, message) {
  try {
    execFileSync("git", gitArgs, {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    throw new Error(message);
  }
}

function assertLocalCoreSource(repoRoot) {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  assertGitCommand(
    repoRoot,
    ["merge-base", "--is-ancestor", EXPECTED_CODE_BASE, "HEAD"],
    "Local checkout must be at or after the reviewed PR #15 code baseline " + EXPECTED_CODE_BASE + ".",
  );
  assertGitCommand(
    repoRoot,
    ["diff", "--quiet", EXPECTED_CODE_BASE, "HEAD", "--", ...PROTECTED_PATHS],
    "Core source/build files differ from the reviewed PR #15 baseline. Stop and reconcile before running.",
  );
  assertGitCommand(
    repoRoot,
    ["diff", "--quiet", "--", ...PROTECTED_PATHS],
    "Core source/build files have unstaged local changes. Stop before running.",
  );
  assertGitCommand(
    repoRoot,
    ["diff", "--cached", "--quiet", "--", ...PROTECTED_PATHS],
    "Core source/build files have staged local changes. Stop before running.",
  );
  const untracked = git(repoRoot, [
    "status", "--porcelain", "--untracked-files=all", "--", ...PROTECTED_PATHS,
  ]);
  if (untracked) {
    throw new Error("Untracked files exist under Core source/build paths. Stop before running.");
  }
  return { head, expectedCodeBase: EXPECTED_CODE_BASE };
}

function isInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

async function importCoreDist(repoRoot, relativePath) {
  const filePath = join(repoRoot, "packages", "core", "dist", relativePath);
  await access(filePath);
  return import(pathToFileURL(filePath).href);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/\bor-v1-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]");
}

function errorSummary(error) {
  const result = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const item = asObject(current);
    result.push({
      name: asString(item.name) || "Error",
      code: asString(item.code) || null,
      message: redact(item.message ?? current).slice(0, 2000),
    });
    current = item.cause;
  }
  return result;
}

function textLength(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textLength(item), 0);
  if (value && typeof value === "object") {
    const item = asObject(value);
    if (item.type === "text" && typeof item.text === "string") return item.text.length;
    return Object.values(item).reduce((sum, child) => sum + textLength(child), 0);
  }
  return 0;
}

function normalizeToolArguments(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return { unparsed: value };
    }
  }
  return value ?? {};
}

function normalizeUsage(value) {
  const usage = asObject(value);
  const promptTokens = finiteNumber(usage.input ?? usage.promptTokens ?? usage.prompt_tokens);
  const completionTokens = finiteNumber(usage.output ?? usage.completionTokens ?? usage.completion_tokens);
  const totalTokens = finiteNumber(usage.totalTokens ?? usage.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function createEvidenceCollector() {
  const events = [];
  const stageByCallId = new Map();

  function record(type, payload) {
    const item = asObject(payload);
    if (type === "model-call-started") {
      const trace = asObject(item.trace);
      const modelCallId = asString(trace.modelCallId) || "untracked-" + events.length;
      const context = asObject(item.context);
      const tools = Array.isArray(context.tools) ? context.tools : [];
      const toolNames = tools.map((tool) => asString(asObject(tool).name)).filter(Boolean);
      const toolName = toolNames[0] || "unknown";
      stageByCallId.set(modelCallId, toolName);
      const messages = Array.isArray(context.messages) ? context.messages : [];
      events.push({
        type,
        modelCallId,
        toolName,
        model: asString(item.model) || null,
        maxTokens: finiteNumber(item.maxTokens),
        context: {
          systemPromptChars: textLength(context.systemPrompt),
          messageCount: messages.length,
          messageChars: messages.reduce((sum, message) => sum + textLength(asObject(message).content), 0),
          toolNames,
        },
      });
      return;
    }

    if (type === "model-request-prepared") {
      const modelCallId = asString(item.modelCallId) || null;
      events.push({
        type,
        modelCallId,
        toolName: stageByCallId.get(modelCallId) || "unknown",
        model: asString(item.model) || null,
        api: asString(item.api) || null,
        parameters: asObject(item.parameters),
      });
      return;
    }

    if (type === "model-call-completed") {
      const modelCallId = asString(item.modelCallId) || null;
      const response = asObject(item.response);
      const content = Array.isArray(response.content) ? response.content : [];
      const toolCalls = content
        .filter((part) => asObject(part).type === "toolCall")
        .map((part) => {
          const call = asObject(part);
          return {
            name: asString(call.name) || null,
            arguments: normalizeToolArguments(call.arguments),
          };
        });
      events.push({
        type,
        modelCallId,
        toolName: stageByCallId.get(modelCallId) || "unknown",
        status: asString(item.status) || null,
        response: {
          model: asString(response.model) || null,
          provider: asString(response.provider) || null,
          api: asString(response.api) || null,
          stopReason: asString(response.stopReason) || null,
          errorCode: asString(response.errorCode) || null,
          errorMessage: redact(response.errorMessage).slice(0, 2000) || null,
          usage: normalizeUsage(response.usage),
          textChars: content
            .filter((part) => asObject(part).type === "text")
            .reduce((sum, part) => sum + textLength(part), 0),
        },
        toolCalls,
      });
      return;
    }

    if (type === "model-call-retry") {
      const modelCallId = asString(item.modelCallId) || null;
      events.push({
        type,
        modelCallId,
        toolName: stageByCallId.get(modelCallId) || "unknown",
        reason: asString(item.reason) || null,
      });
      return;
    }

    if (type === "worker-result-invalid") {
      events.push({
        type,
        resultTool: asString(item.resultTool) || null,
        code: asString(item.code) || null,
        message: redact(item.message).slice(0, 1200) || null,
        issueCount: Array.isArray(item.issues) ? item.issues.length : null,
      });
      return;
    }

    if (type === "skills-applied") {
      const skills = Array.isArray(item.skills) ? item.skills : [];
      events.push({
        type,
        worker: asString(item.worker) || null,
        skills: skills.map((skill) => {
          const entry = asObject(skill);
          return {
            id: asString(entry.id) || null,
            source: asString(entry.source) || null,
            hash: asString(entry.hash) || null,
          };
        }),
      });
      return;
    }

    if (type === "worker-arguments-decoded") {
      events.push({
        type,
        resultTool: asString(item.resultTool) || null,
        paths: Array.isArray(item.paths) ? item.paths.filter((path) => typeof path === "string") : [],
      });
      return;
    }

    if (type === "model-tool-output-discarded") {
      events.push({
        type,
        reason: asString(item.reason) || null,
        toolCount: finiteNumber(item.toolCount),
      });
    }
  }

  return { events, record };
}

function summarizeStages(events, foundationReturned) {
  const started = events.filter((event) => event.type === "model-call-started");
  const prepared = events.filter((event) => event.type === "model-request-prepared");
  const completed = events.filter((event) => event.type === "model-call-completed");
  const retries = events.filter((event) => event.type === "model-call-retry");
  const invalid = events.filter((event) => event.type === "worker-result-invalid");
  const highestStageIndex = Math.max(
    -1,
    ...started.map((event) => STAGES.indexOf(event.toolName)),
  );

  return STAGES.map((toolName, index) => {
    const calls = started.filter((event) => event.toolName === toolName);
    const callIds = new Set(calls.map((event) => event.modelCallId));
    const stageCompleted = completed.filter((event) => callIds.has(event.modelCallId));
    const stagePrepared = prepared.filter((event) => callIds.has(event.modelCallId));
    const stageRetries = retries.filter((event) => callIds.has(event.modelCallId));
    const stageInvalid = invalid.filter((event) => event.resultTool === toolName);
    const toolCallCount = stageCompleted.reduce(
      (sum, event) => sum + event.toolCalls.filter((call) => call.name === toolName).length,
      0,
    );
    const usage = stageCompleted.reduce((total, event) => ({
      promptTokens: total.promptTokens + event.response.usage.promptTokens,
      completionTokens: total.completionTokens + event.response.usage.completionTokens,
      totalTokens: total.totalTokens + event.response.usage.totalTokens,
    }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    const nextStageStarted = index < STAGES.length - 1
      && started.some((event) => event.toolName === STAGES[index + 1]);
    return {
      toolName,
      modelCalls: calls.length,
      preparedRequests: stagePrepared.length,
      toolCallsReturned: toolCallCount,
      invalidResults: stageInvalid.length,
      retryReasons: stageRetries.map((event) => event.reason),
      acceptedByPipeline: Boolean(foundationReturned) || nextStageStarted,
      usage,
    };
  });
}

function sumUsage(events) {
  return events
    .filter((event) => event.type === "model-call-completed")
    .reduce((total, event) => ({
      promptTokens: total.promptTokens + event.response.usage.promptTokens,
      completionTokens: total.completionTokens + event.response.usage.completionTokens,
      totalTokens: total.totalTokens + event.response.usage.totalTokens,
    }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
}

function collectText(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectText(child, output);
  }
  return output;
}

function assessLanguage(value) {
  const text = collectText(value).join("\n");
  const cyrillicLetters = (text.match(/[А-Яа-яЁё]/g) || []).length;
  const latinLetters = (text.match(/[A-Za-z]/g) || []).length;
  const totalLetters = cyrillicLetters + latinLetters;
  const cyrillicRatio = totalLetters ? cyrillicLetters / totalLetters : null;
  return {
    expected: "ru",
    cyrillicLetters,
    latinLetters,
    cyrillicRatio,
    heuristic: cyrillicRatio === null
      ? "UNKNOWN"
      : cyrillicRatio >= 0.45
        ? "LIKELY_RUSSIAN"
        : "LIKELY_NOT_RUSSIAN",
    note: "Heuristic only; not a literary-quality score.",
  };
}

function validateFoundation(output) {
  if (!output) return null;
  const issues = [];
  if (!asString(output.storyFrame).trim()) issues.push("storyFrame is empty");
  if (!asString(output.volumeMap).trim()) issues.push("volumeMap is empty");
  if (!asString(output.bookRules).trim()) issues.push("bookRules is empty");
  if (!output.bookRulesData || typeof output.bookRulesData !== "object") issues.push("bookRulesData is missing");
  if (!Array.isArray(output.roles) || output.roles.length === 0) {
    issues.push("roles is empty");
  } else {
    const names = output.roles.map((role) => asString(asObject(role).name).trim().toLocaleLowerCase());
    if (names.some((name) => !name)) issues.push("a role has an empty name");
    if (new Set(names).size !== names.length) issues.push("role names are not unique");
    for (const role of output.roles) {
      const item = asObject(role);
      if (!asString(item.content).trim()) issues.push("role card is empty: " + asString(item.name));
      if (item.tier !== "major" && item.tier !== "minor") issues.push("invalid role tier: " + asString(item.name));
    }
  }
  return {
    passed: issues.length === 0,
    issues,
    roleCount: Array.isArray(output.roles) ? output.roles.length : 0,
    majorRoleCount: Array.isArray(output.roles)
      ? output.roles.filter((role) => asObject(role).tier === "major").length
      : 0,
    minorRoleCount: Array.isArray(output.roles)
      ? output.roles.filter((role) => asObject(role).tier === "minor").length
      : 0,
    hookCount: Array.isArray(output.initialHooks) ? output.initialHooks.length : 0,
  };
}

async function loadBenchmarkBrief(repoRoot) {
  const path = join(repoRoot, "fork-docs", "BENCHMARK_LONGFORM.md");
  const source = await readFile(path, "utf8");
  const startMarker = "**BEGIN STORY BRIEF v1.0**";
  const endMarker = "**END STORY BRIEF v1.0**";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error("Could not find the exact R3 v1.0 brief markers in fork-docs/BENCHMARK_LONGFORM.md.");
  }
  const brief = source.slice(start + startMarker.length, end).trim();
  if (!brief.includes("RiverLine") || !brief.includes("19:00")) {
    throw new Error("The extracted R3 brief does not match the expected v1.0 fixture.");
  }
  return {
    brief,
    sha256: createHash("sha256").update(brief, "utf8").digest("hex"),
    sourcePath: "fork-docs/BENCHMARK_LONGFORM.md",
  };
}

function validateOutputPath(outputPath, repoRoot, projectRoot) {
  if (!outputPath) return;
  if (isInside(repoRoot, outputPath) || isInside(projectRoot, outputPath)) {
    throw new Error("--output must be outside both the repository and Studio workspace.");
  }
}

async function emitReport(report, outputPath) {
  const json = JSON.stringify(report, null, 2) + "\n";
  if (!outputPath) {
    process.stdout.write(json);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, "utf8");
  process.stdout.write(JSON.stringify({
    status: report.status,
    reportPath: outputPath,
    model: report.model?.requestedModel ?? null,
    liveApiCalled: report.liveApiCalled,
    usage: report.usage ?? null,
  }, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  validateOutputPath(args.output, args.repoRoot, args.projectRoot);

  // This guard exists only in this child process and is never written to disk.
  process.env.INKOS_OPENROUTER_FREE_ONLY = "1";

  const code = assertLocalCoreSource(args.repoRoot);
  const providerDist = await readFile(join(args.repoRoot, "packages", "core", "dist", "llm", "provider.js"), "utf8");
  const piStreamDist = await readFile(join(args.repoRoot, "packages", "core", "dist", "agent", "pi-stream.js"), "utf8");
  if (!providerDist.includes("normalizeOpenRouterReasoningPayload")
    || !piStreamDist.includes("normalizeOpenRouterReasoningPayload")) {
    throw new Error("Built Core dist does not contain the PR #15 OpenRouter reasoning fix. Rebuild from the reviewed code baseline first.");
  }
  await access(join(args.repoRoot, "packages", "core", "dist", "index.js"));

  const [
    { loadProjectConfig },
    { createLLMClient },
    { PipelineRunner },
    { ArchitectAgent },
    { BookConfigSchema },
    { withExecutionEvidence },
    { createBuiltInWorkProfileRegistry },
    { loadAvailableAgentSkills },
    { resolveProfileSkillActivations },
    { runWithAgentTrajectory, opaqueConversationId },
    { resolveNarrativeLanguage },
  ] = await Promise.all([
    importCoreDist(args.repoRoot, "utils/config-loader.js"),
    importCoreDist(args.repoRoot, "llm/provider.js"),
    importCoreDist(args.repoRoot, "pipeline/runner.js"),
    importCoreDist(args.repoRoot, "agents/architect.js"),
    importCoreDist(args.repoRoot, "models/book.js"),
    importCoreDist(args.repoRoot, "harness/execution-evidence.js"),
    importCoreDist(args.repoRoot, "harness/builtin-profiles.js"),
    importCoreDist(args.repoRoot, "skills/builtin-loader.js"),
    importCoreDist(args.repoRoot, "skills/activations.js"),
    importCoreDist(args.repoRoot, "llm/agent-trajectory.js"),
    importCoreDist(args.repoRoot, "utils/book-language.js"),
  ]);

  const project = await loadProjectConfig(args.projectRoot, {
    consumer: "studio",
    requireApiKey: true,
  });
  const llm = project.llm;
  if (llm.service !== "openrouter") throw new Error("Studio service must be openrouter; got " + llm.service);
  if (new URL(llm.baseUrl).origin !== "https://openrouter.ai") {
    throw new Error("Only the official https://openrouter.ai endpoint is allowed.");
  }
  if (llm.apiFormat !== "responses") throw new Error("Studio apiFormat must be responses; got " + llm.apiFormat);
  if (!(llm.model === "openrouter/free" || llm.model.toLowerCase().endsWith(":free"))) {
    throw new Error("The configured base model must itself be free (openrouter/free or a :free ID).");
  }
  if (!llm.apiKey) throw new Error("Studio OpenRouter API key is missing.");
  const forbiddenExtra = ["models", "route", "plugins"].filter((key) => key in (llm.extra || {}));
  if (forbiddenExtra.length) {
    throw new Error("Free-only mode forbids these LLM extra fields: " + forbiddenExtra.join(", "));
  }

  const baseClient = createLLMClient(llm);
  const runner = new PipelineRunner({
    client: baseClient,
    model: llm.model,
    projectRoot: args.projectRoot,
    // Deliberately replace, not merge, persistent overrides: this run has one
    // in-memory Architect override and cannot mutate inkos.json.
    modelOverrides: { architect: { model: args.model } },
  });

  const profileRegistry = createBuiltInWorkProfileRegistry(args.projectRoot);
  const profile = profileRegistry.require("longform-novel");
  const skillLoad = await loadAvailableAgentSkills({ projectRoot: args.projectRoot });
  const skillActivations = resolveProfileSkillActivations(skillLoad.skills, profile);
  const workerSkills = (agent) => agent === "architect" ? skillActivations : [];
  const benchmark = await loadBenchmarkBrief(args.repoRoot);

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const book = BookConfigSchema.parse({
    id: "g1-architect-smoke-" + runId.slice(0, 8),
    title: "Последняя ведомость",
    platform: "Author.Today",
    genre: "камерный социальный триллер",
    status: "outlining",
    targetChapters: 5,
    chapterWordCount: 1350,
    language: "en",
    narrativeLanguage: "ru",
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  const expectedNarrativeLanguage = resolveNarrativeLanguage(book);
  const context = await runner.runWithAgentContext(
    { workerSkills },
    async () => runner.createAgentContext("architect", book.id),
  );
  const piModel = asObject(context.client._piModel);
  const modelInfo = {
    requestedModel: args.model,
    resolvedModel: context.model,
    piModelId: asString(piModel.id) || null,
    piModelName: asString(piModel.name) || null,
    piApi: asString(piModel.api) || null,
    service: context.client.service,
    apiFormat: context.client.apiFormat,
    baseUrl: asString(piModel.baseUrl) || null,
    stream: context.client.stream,
    contextWindow: finiteNumber(piModel.contextWindow),
    maxTokens: finiteNumber(context.client.defaults.maxTokens),
    hasKey: Boolean(context.client._apiKey),
  };
  if (modelInfo.resolvedModel !== args.model || modelInfo.piModelName !== args.model) {
    throw new Error("In-memory Architect model override did not resolve to the requested fixed ID.");
  }

  const report = {
    schemaVersion: 1,
    task: "G1_ARCHITECT_FOUNDATION_SMOKE",
    status: args.run ? "PENDING" : "PREFLIGHT_PASS_NO_API",
    liveApiCalled: false,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    code: {
      localHead: code.head,
      requiredCodeBase: code.expectedCodeBase,
      sourceMatchesRequiredBaseline: true,
      reasoningFixFingerprintPresentInDist: true,
      distBuildProvenance: "The script checks the PR #15 code ancestry and reasoning-fix fingerprint; it cannot prove when the local dist was built. User-confirmed Core build from the reviewed code baseline is required.",
    },
    project: {
      projectRoot: args.projectRoot,
      service: llm.service,
      baseModel: llm.model,
      apiFormat: llm.apiFormat,
      stream: llm.stream,
      hasKey: Boolean(llm.apiKey),
      persistentModelOverridesIgnored: true,
      freeOnlyGuard: "INKOS_OPENROUTER_FREE_ONLY=1 (child process only)",
    },
    model: modelInfo,
    profile: {
      id: profile.id,
      requiredSkillIds: profile.requiredSkillIds,
      activatedSkillIds: skillActivations.map((item) => item.skill.id),
      skillDiagnosticCount: skillLoad.diagnostics.length,
    },
    benchmark: {
      id: "R3",
      version: "1.0",
      sourcePath: benchmark.sourcePath,
      briefSha256: benchmark.sha256,
    },
    book: {
      id: book.id,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      language: book.language,
      narrativeLanguage: book.narrativeLanguage,
      resolvedNarrativeLanguage: expectedNarrativeLanguage,
      targetChapters: book.targetChapters,
      chapterWordCount: book.chapterWordCount,
    },
    generationParameters: {
      temperature: 0.8,
      maxTokensByStage: {
        submit_foundation_outline: Math.min(8192, modelInfo.maxTokens),
        submit_foundation_details: modelInfo.maxTokens,
        submit_foundation_cast_index: Math.min(2048, modelInfo.maxTokens),
        submit_foundation_cast_documents: Math.min(8192, modelInfo.maxTokens),
      },
      stream: modelInfo.stream,
      requiredToolChoice: true,
    },
    languageContract: {
      expected: expectedNarrativeLanguage,
      promptLanguageSelectedByArchitect: book.language,
      warning: LANGUAGE_CONTRACT_WARNING,
    },
    writes: {
      workCreated: false,
      foundationFilesWritten: false,
      workspaceFilesWritten: false,
      note: "ArchitectAgent.generateFoundation is called directly; initBook and writeFoundationFiles are never called.",
    },
    usage: null,
    stages: null,
    evidence: [],
    partialOutline: null,
    foundation: null,
    foundationValidation: null,
    languageAssessment: null,
    errors: [],
    cost: "Not inferred from token usage; reconcile with OpenRouter Activity after the run.",
  };

  if (!args.run) {
    report.finishedAt = new Date().toISOString();
    await emitReport(report, args.output);
    return;
  }

  const collector = createEvidenceCollector();
  let partialOutline = null;
  let foundation = null;
  const startTime = Date.now();
  report.liveApiCalled = true;
  try {
    const architect = new ArchitectAgent(context);
    foundation = await runWithAgentTrajectory({
      conversationId: opaqueConversationId(runId),
      runId,
      agentRole: "main",
    }, () => withExecutionEvidence(
      collector.record,
      () => architect.generateFoundation(book, benchmark.brief, undefined, {
        onOutline: (outline) => { partialOutline = outline; },
      }),
      profile,
      null,
    ));
    report.status = "STRUCTURED_PIPELINE_PASS";
  } catch (error) {
    report.status = "FAIL";
    report.errors = errorSummary(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startTime;
    report.evidence = collector.events;
    report.stages = summarizeStages(collector.events, Boolean(foundation));
    report.usage = sumUsage(collector.events);
    report.partialOutline = partialOutline;
    report.foundation = foundation;
    report.foundationValidation = validateFoundation(foundation);
    report.languageAssessment = assessLanguage(foundation ?? {
      partialOutline,
      toolCalls: collector.events
        .filter((event) => event.type === "model-call-completed")
        .flatMap((event) => event.toolCalls),
    });
    const allStagesAccepted = report.stages.every((stage) => stage.acceptedByPipeline);
    if (foundation && report.foundationValidation?.passed && allStagesAccepted) {
      report.status = "STRUCTURED_PIPELINE_PASS";
    } else if (foundation) {
      report.status = "PIPELINE_RETURNED_WITH_VALIDATION_OR_EVIDENCE_GAPS";
    } else {
      report.status = "FAIL";
    }
  }

  await emitReport(report, args.output);
  if (report.status !== "STRUCTURED_PIPELINE_PASS") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write("G1_ARCHITECT_SMOKE_PREFLIGHT_FAIL: " + redact(error?.message ?? error) + "\n");
  process.exitCode = 2;
});
