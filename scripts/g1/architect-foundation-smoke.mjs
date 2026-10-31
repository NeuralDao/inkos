#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CODE_BASE = "ee4c57e496db561b3d0ad9675d604a886e950941";
const MODELS = new Set([
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
const CORE_PATHS = [
  "packages/core/src", "packages/core/package.json", "packages/core/tsconfig.json",
  "tsconfig.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
  "scripts/clean-package-dist.mjs",
];
const LANGUAGE_WARNING =
  "ArchitectAgent.generateFoundation selects its prompt language from BookConfig.language and explicitly requests English for language='en'; it does not use narrativeLanguage. With R3's language='en', narrativeLanguage='ru' pair, this run validates the four-stage pipeline but cannot qualify Russian foundation prose.";

function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), projectRoot: "", model: "", output: "", run: false, confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") return { help: true };
    if (key === "--run") { args.run = true; continue; }
    if (key === "--dry-run") { args.run = false; continue; }
    if (key === "--confirm-live-llm") { args.confirm = true; continue; }
    const fields = { "--repo-root": "repoRoot", "--project-root": "projectRoot", "--model": "model", "--output": "output" };
    if (!fields[key] || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Invalid or missing argument: " + key);
    args[fields[key]] = argv[++i];
  }
  if (!args.projectRoot || !args.model) throw new Error("--project-root and --model are required.");
  if (!MODELS.has(args.model)) throw new Error("Model is not in the G1 allowlist: " + args.model);
  if (args.run !== args.confirm) throw new Error("Live calls require both --run and --confirm-live-llm.");
  args.repoRoot = resolve(args.repoRoot);
  args.projectRoot = resolve(args.projectRoot);
  if (args.output) args.output = resolve(args.output);
  return args;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function assertGit(root, args, message) {
  try { execFileSync("git", args, { cwd: root, stdio: "ignore" }); }
  catch { throw new Error(message); }
}

function assertSourceBaseline(root) {
  const head = git(root, ["rev-parse", "HEAD"]);
  assertGit(root, ["merge-base", "--is-ancestor", CODE_BASE, "HEAD"],
    "Checkout must be at or after reviewed PR #15 code baseline " + CODE_BASE + ".");
  assertGit(root, ["diff", "--quiet", CODE_BASE, "HEAD", "--", ...CORE_PATHS],
    "Core source/build files differ from the reviewed PR #15 baseline.");
  assertGit(root, ["diff", "--quiet", "--", ...CORE_PATHS], "Core source has unstaged changes.");
  assertGit(root, ["diff", "--cached", "--quiet", "--", ...CORE_PATHS], "Core source has staged changes.");
  if (git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...CORE_PATHS])) {
    throw new Error("Untracked files exist under Core source/build paths.");
  }
  return head;
}

function inside(parent, target) {
  const rel = relative(resolve(parent), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

async function distImport(root, file) {
  const path = join(root, "packages", "core", "dist", file);
  await access(path);
  return import(pathToFileURL(path).href);
}

const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const str = (value) => typeof value === "string" ? value : "";
const num = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const redact = (value) => String(value ?? "")
  .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
  .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
  .replace(/\bor-v1-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]");

function usageOf(value) {
  const u = obj(value);
  const promptTokens = num(u.input ?? u.promptTokens ?? u.prompt_tokens);
  const completionTokens = num(u.output ?? u.completionTokens ?? u.completion_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: num(u.totalTokens ?? u.total_tokens) || promptTokens + completionTokens,
  };
}

function errorChain(error) {
  const result = [];
  for (let current = error, depth = 0; current && depth < 4; current = obj(current).cause, depth += 1) {
    const item = obj(current);
    result.push({
      name: str(item.name) || "Error",
      code: str(item.code) || null,
      message: redact(item.message ?? current).slice(0, 2000),
    });
  }
  return result;
}

function parseToolArgs(value) {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return { unparsed: value }; }
}

function createEvidence() {
  const events = [];
  const stageByCall = new Map();
  const record = (type, payload) => {
    const p = obj(payload);
    if (type === "model-call-started") {
      const id = str(obj(p.trace).modelCallId) || "untracked-" + events.length;
      const tools = Array.isArray(obj(p.context).tools) ? obj(p.context).tools : [];
      const names = tools.map((tool) => str(obj(tool).name)).filter(Boolean);
      const stage = names[0] || "unknown";
      stageByCall.set(id, stage);
      events.push({ type, id, stage, model: str(p.model), maxTokens: num(p.maxTokens) });
    } else if (type === "model-request-prepared") {
      const id = str(p.modelCallId);
      events.push({
        type, id, stage: stageByCall.get(id) || "unknown",
        model: str(p.model), api: str(p.api), parameters: obj(p.parameters),
      });
    } else if (type === "model-call-completed") {
      const id = str(p.modelCallId);
      const response = obj(p.response);
      const content = Array.isArray(response.content) ? response.content : [];
      const toolCalls = content.filter((part) => obj(part).type === "toolCall").map((part) => ({
        name: str(obj(part).name),
        arguments: parseToolArgs(obj(part).arguments),
      }));
      events.push({
        type, id, stage: stageByCall.get(id) || "unknown", status: str(p.status),
        response: {
          model: str(response.model), provider: str(response.provider), api: str(response.api),
          stopReason: str(response.stopReason), errorCode: str(response.errorCode),
          errorMessage: redact(response.errorMessage).slice(0, 1600) || null,
          usage: usageOf(response.usage),
        },
        toolCalls,
      });
    } else if (type === "model-call-retry") {
      const id = str(p.modelCallId);
      events.push({ type, id, stage: stageByCall.get(id) || "unknown", reason: str(p.reason) });
    } else if (type === "worker-result-invalid") {
      events.push({
        type, stage: str(p.resultTool), code: str(p.code),
        issueCount: Array.isArray(p.issues) ? p.issues.length : null,
        message: redact(p.message).slice(0, 1000) || null,
      });
    } else if (type === "skills-applied") {
      events.push({
        type, worker: str(p.worker),
        skills: (Array.isArray(p.skills) ? p.skills : []).map((skill) => ({
          id: str(obj(skill).id), source: str(obj(skill).source), hash: str(obj(skill).hash),
        })),
      });
    }
  };
  return { events, record };
}

function stageSummary(events, returned) {
  const started = events.filter((e) => e.type === "model-call-started");
  const prepared = events.filter((e) => e.type === "model-request-prepared");
  const completed = events.filter((e) => e.type === "model-call-completed");
  const retries = events.filter((e) => e.type === "model-call-retry");
  const invalid = events.filter((e) => e.type === "worker-result-invalid");
  return STAGES.map((stage, index) => {
    const calls = started.filter((e) => e.stage === stage);
    const ids = new Set(calls.map((e) => e.id));
    const done = completed.filter((e) => ids.has(e.id));
    const usage = done.reduce((sum, e) => ({
      promptTokens: sum.promptTokens + e.response.usage.promptTokens,
      completionTokens: sum.completionTokens + e.response.usage.completionTokens,
      totalTokens: sum.totalTokens + e.response.usage.totalTokens,
    }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    return {
      stage,
      modelCalls: calls.length,
      preparedRequests: prepared.filter((e) => ids.has(e.id)).length,
      toolCallsReturned: done.reduce((sum, e) => sum + e.toolCalls.filter((call) => call.name === stage).length, 0),
      invalidResults: invalid.filter((e) => e.stage === stage).length,
      retryReasons: retries.filter((e) => ids.has(e.id)).map((e) => e.reason),
      acceptedByPipeline: Boolean(returned) || (index < STAGES.length - 1
        && started.some((e) => e.stage === STAGES[index + 1])),
      usage,
    };
  });
}

function totalUsage(events) {
  return events.filter((e) => e.type === "model-call-completed").reduce((sum, e) => ({
    promptTokens: sum.promptTokens + e.response.usage.promptTokens,
    completionTokens: sum.completionTokens + e.response.usage.completionTokens,
    totalTokens: sum.totalTokens + e.response.usage.totalTokens,
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
}

function textValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => textValues(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => textValues(item, output));
  return output;
}

function languageCheck(value) {
  const text = textValues(value).join("\n");
  const cyr = (text.match(/[А-Яа-яЁё]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const ratio = cyr + latin ? cyr / (cyr + latin) : null;
  return {
    expected: "ru", cyrillicLetters: cyr, latinLetters: latin, cyrillicRatio: ratio,
    heuristic: ratio === null ? "UNKNOWN" : ratio >= 0.45 ? "LIKELY_RUSSIAN" : "LIKELY_NOT_RUSSIAN",
    note: "Heuristic only; not a literary-quality score.",
  };
}

function validateFoundation(value) {
  if (!value) return null;
  const issues = [];
  if (!str(value.storyFrame).trim()) issues.push("storyFrame is empty");
  if (!str(value.volumeMap).trim()) issues.push("volumeMap is empty");
  if (!str(value.bookRules).trim()) issues.push("bookRules is empty");
  if (!value.bookRulesData || typeof value.bookRulesData !== "object") issues.push("bookRulesData is missing");
  const roles = Array.isArray(value.roles) ? value.roles : [];
  if (!roles.length) issues.push("roles is empty");
  const names = roles.map((role) => str(obj(role).name).trim().toLocaleLowerCase());
  if (names.some((name) => !name)) issues.push("a role has an empty name");
  if (new Set(names).size !== names.length) issues.push("role names are not unique");
  for (const role of roles) {
    if (!str(obj(role).content).trim()) issues.push("empty character card: " + str(obj(role).name));
    if (obj(role).tier !== "major" && obj(role).tier !== "minor") issues.push("invalid role tier: " + str(obj(role).name));
  }
  return {
    passed: issues.length === 0, issues, roleCount: roles.length,
    majorRoleCount: roles.filter((role) => obj(role).tier === "major").length,
    minorRoleCount: roles.filter((role) => obj(role).tier === "minor").length,
    hookCount: Array.isArray(value.initialHooks) ? value.initialHooks.length : 0,
  };
}

async function benchmarkBrief(repoRoot) {
  const source = await readFile(join(repoRoot, "fork-docs", "BENCHMARK_LONGFORM.md"), "utf8");
  const begin = "**BEGIN STORY BRIEF v1.0**";
  const end = "**END STORY BRIEF v1.0**";
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) throw new Error("R3 v1.0 brief markers are missing.");
  const brief = source.slice(start + begin.length, finish).trim();
  if (!brief.includes("RiverLine") || !brief.includes("19:00")) throw new Error("R3 fixture fingerprint mismatch.");
  return { brief, sha256: createHash("sha256").update(brief).digest("hex") };
}

async function outputReport(report, path) {
  const json = JSON.stringify(report, null, 2) + "\n";
  if (!path) return process.stdout.write(json);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, "utf8");
  process.stdout.write(JSON.stringify({
    status: report.status, reportPath: path, model: report.model.requestedModel,
    liveApiCalled: report.liveApiCalled, usage: report.usage,
  }, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write([
    "G1 Architect foundation smoke (one model per run)",
    "Required: --project-root <path> --model <allowlisted :free ID>",
    "Optional: --repo-root <path> --output <path> --dry-run",
    "Live only: --run --confirm-live-llm",
    "Default is a no-API preflight. No Work or Foundation files are created.",
  ].join("\n") + "\n");

  if (args.output && (inside(args.repoRoot, args.output) || inside(args.projectRoot, args.output))) {
    throw new Error("--output must be outside the repository and Studio workspace.");
  }

  process.env.INKOS_OPENROUTER_FREE_ONLY = "1";
  const head = assertSourceBaseline(args.repoRoot);
  const providerDist = await readFile(join(args.repoRoot, "packages/core/dist/llm/provider.js"), "utf8");
  const streamDist = await readFile(join(args.repoRoot, "packages/core/dist/agent/pi-stream.js"), "utf8");
  if (!providerDist.includes("normalizeOpenRouterReasoningPayload")
    || !streamDist.includes("normalizeOpenRouterReasoningPayload")) {
    throw new Error("Core dist is missing the PR #15 reasoning fix; rebuild from the reviewed code baseline.");
  }

  const [
    { loadProjectConfig }, { createLLMClient }, { PipelineRunner }, { ArchitectAgent },
    { BookConfigSchema }, { withExecutionEvidence }, { createBuiltInWorkProfileRegistry },
    { runWithAgentTrajectory, opaqueConversationId }, { resolveNarrativeLanguage },
  ] = await Promise.all([
    distImport(args.repoRoot, "utils/config-loader.js"),
    distImport(args.repoRoot, "llm/provider.js"),
    distImport(args.repoRoot, "pipeline/runner.js"),
    distImport(args.repoRoot, "agents/architect.js"),
    distImport(args.repoRoot, "models/book.js"),
    distImport(args.repoRoot, "harness/execution-evidence.js"),
    distImport(args.repoRoot, "harness/builtin-profiles.js"),
    distImport(args.repoRoot, "llm/agent-trajectory.js"),
    distImport(args.repoRoot, "utils/book-language.js"),
  ]);

  const project = await loadProjectConfig(args.projectRoot, { consumer: "studio", requireApiKey: true });
  const llm = project.llm;
  if (llm.service !== "openrouter" || new URL(llm.baseUrl).origin !== "https://openrouter.ai") {
    throw new Error("Studio must use the official OpenRouter endpoint.");
  }
  if (llm.apiFormat !== "responses") throw new Error("Studio apiFormat must be responses.");
  if (!(llm.model === "openrouter/free" || llm.model.toLowerCase().endsWith(":free"))) {
    throw new Error("Configured base model must be openrouter/free or a :free ID.");
  }
  if (!llm.apiKey) throw new Error("Studio OpenRouter API key is missing.");
  const forbidden = ["models", "route", "plugins"].filter((key) => key in (llm.extra || {}));
  if (forbidden.length) throw new Error("Free-only mode forbids LLM extra fields: " + forbidden.join(", "));

  const client = createLLMClient(llm);
  const runner = new PipelineRunner({
    client, model: llm.model, projectRoot: args.projectRoot,
    modelOverrides: { architect: { model: args.model } },
  });
  const profile = createBuiltInWorkProfileRegistry(args.projectRoot).require("longform-novel");
  const benchmark = await benchmarkBrief(args.repoRoot);
  const runId = randomUUID();
  const now = new Date().toISOString();
  const book = BookConfigSchema.parse({
    id: "g1-architect-smoke-" + runId.slice(0, 8),
    title: "Последняя ведомость", platform: "Author.Today",
    genre: "камерный социальный триллер", status: "outlining",
    targetChapters: 5, chapterWordCount: 1350,
    language: "en", narrativeLanguage: "ru", createdAt: now, updatedAt: now,
  });
  const expectedLanguage = resolveNarrativeLanguage(book);
  const context = runner.createAgentContext("architect", book.id);
  const piModel = obj(context.client._piModel);
  const model = {
    requestedModel: args.model, resolvedModel: context.model,
    piModelId: str(piModel.id), piModelName: str(piModel.name),
    piApi: str(piModel.api), service: context.client.service,
    apiFormat: context.client.apiFormat, baseUrl: str(piModel.baseUrl),
    stream: context.client.stream, contextWindow: num(piModel.contextWindow),
    maxTokens: num(context.client.defaults.maxTokens), hasKey: Boolean(context.client._apiKey),
  };
  if (model.resolvedModel !== args.model || model.piModelName !== args.model
    || model.service !== "openrouter" || model.apiFormat !== "responses"
    || model.piApi !== "openai-responses" || !model.hasKey
    || new URL(model.baseUrl).origin !== "https://openrouter.ai") {
    throw new Error("Resolved Architect override does not match the required OpenRouter Responses deployment.");
  }

  const report = {
    schemaVersion: 1, task: "G1_ARCHITECT_FOUNDATION_SMOKE",
    status: args.run ? "PENDING" : "PREFLIGHT_PASS_NO_API",
    liveApiCalled: false, code: { head, requiredBase: CODE_BASE, reasoningFixFingerprintPresent: true },
    project: {
      root: args.projectRoot, service: llm.service, baseModel: llm.model,
      apiFormat: llm.apiFormat, stream: llm.stream, hasKey: Boolean(llm.apiKey),
      persistentModelOverridesIgnored: true, freeOnlyGuard: "INKOS_OPENROUTER_FREE_ONLY=1 (child process only)",
    },
    model, profile: { id: profile.id, requiredSkillIds: profile.requiredSkillIds },
    benchmark: { id: "R3", version: "1.0", briefSha256: benchmark.sha256 },
    book: {
      id: book.id, title: book.title, genre: book.genre, language: book.language,
      narrativeLanguage: book.narrativeLanguage, resolvedNarrativeLanguage: expectedLanguage,
      targetChapters: book.targetChapters, chapterWordCount: book.chapterWordCount,
    },
    generationParameters: {
      temperature: 0.8, requiredToolChoice: true, stream: model.stream,
      maxTokensByStage: {
        submit_foundation_outline: Math.min(8192, model.maxTokens),
        submit_foundation_details: model.maxTokens,
        submit_foundation_cast_index: Math.min(2048, model.maxTokens),
        submit_foundation_cast_documents: Math.min(8192, model.maxTokens),
      },
    },
    languageContract: { expected: expectedLanguage, promptLanguageSelectedByArchitect: book.language, warning: LANGUAGE_WARNING },
    writes: { workCreated: false, foundationFilesWritten: false, workspaceFilesWritten: false },
    usage: null, stages: null, evidence: [], partialOutline: null,
    foundation: null, foundationValidation: null, languageAssessment: null, errors: [],
    cost: "Not inferred from tokens; reconcile with OpenRouter Activity.",
  };

  if (!args.run) return outputReport(report, args.output);

  const evidence = createEvidence();
  let partialOutline = null;
  let foundation = null;
  const started = Date.now();
  report.liveApiCalled = true;
  try {
    const architect = new ArchitectAgent(context);
    foundation = await runWithAgentTrajectory({
      conversationId: opaqueConversationId(runId), runId, agentRole: "main",
    }, () => withExecutionEvidence(
      evidence.record,
      () => architect.generateFoundation(book, benchmark.brief, undefined, {
        onOutline: (outline) => { partialOutline = outline; },
      }),
      profile,
      null,
    ));
  } catch (error) {
    report.errors = errorChain(error);
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  report.evidence = evidence.events;
  report.stages = stageSummary(evidence.events, Boolean(foundation));
  report.usage = totalUsage(evidence.events);
  report.partialOutline = partialOutline;
  report.foundation = foundation;
  report.foundationValidation = validateFoundation(foundation);
  report.languageAssessment = languageCheck(foundation || {
    partialOutline,
    toolCalls: evidence.events.filter((e) => e.type === "model-call-completed").flatMap((e) => e.toolCalls),
  });
  const allAccepted = report.stages.every((stage) => stage.acceptedByPipeline);
  report.status = foundation && report.foundationValidation.passed && allAccepted
    ? "STRUCTURED_PIPELINE_PASS"
    : foundation ? "PIPELINE_RETURNED_WITH_VALIDATION_OR_EVIDENCE_GAPS" : "FAIL";
  await outputReport(report, args.output);
  if (report.status !== "STRUCTURED_PIPELINE_PASS") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write("G1_ARCHITECT_SMOKE_PREFLIGHT_FAIL: " + redact(error?.message ?? error) + "\n");
  process.exitCode = 2;
});
