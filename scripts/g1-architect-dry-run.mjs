#!/usr/bin/env node

/**
 * Bounded G1 Architect dry-run.
 *
 * - Uses the real Core ArchitectAgent.generateFoundation() path.
 * - Uses an in-memory modelOverrides.architect for one allowlisted :free model.
 * - Does not call PipelineRunner.initBook() or ArchitectAgent.writeFoundationFiles().
 * - Does not create a Work, book directory, Foundation artifact, or change inkos.json.
 * - Reads Studio's existing LLM credentials/configuration but never prints secrets.
 * - Saves a sanitized execution report outside the repository.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArchitectAgent,
  BookConfigSchema,
  createLLMClient,
  loadProjectConfig,
  PipelineRunner,
} from "../packages/core/dist/index.js";
import { createBuiltInWorkProfileRegistry } from "../packages/core/dist/harness/builtin-profiles.js";
import { withExecutionEvidence } from "../packages/core/dist/harness/execution-evidence.js";
import {
  opaqueConversationId,
  runWithAgentTrajectory,
} from "../packages/core/dist/llm/agent-trajectory.js";

const ALLOWED_MODELS = new Set([
  "nvidia/nemotron-3.5-super-vl:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "cohere/north-mini-code:free",
]);

const EXPECTED_STAGES = [
  "submit_foundation_outline",
  "submit_foundation_details",
  "submit_foundation_cast_index",
  "submit_foundation_cast_documents",
];

const MAX_OUTPUT_TOKENS = 4096;
const MAX_PREPARED_REQUESTS = 12;
const TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_PROJECT_ROOT = "C:\\Projects\\inkos-workspace";
const DEFAULT_REPORT_DIR = "C:\\Projects\\inkos-review-artifacts\\g1-architect-dry-run";

const SYNTHETIC_BRIEF = [
  "Create a self-contained five-chapter social mystery. This is a synthetic test premise, not a real manuscript.",
  "After a severe flood, a small town's municipal relief office used a paper ledger to record compensation payments. During a later digitization project, junior archivist Mara Venn finds two conflicting copies: one lists a payment to a family whose home was outside the flood zone, while another omits a payment to a family whose home was destroyed.",
  "Deputy mayor Anton Vale controls access to the remaining municipal records and insists that the differences are harmless corrections. Retired clerk Daria Sokolov kept a carbon copy of the original ledger but has concealed it because revealing the correction would also expose a decision she made to protect a vulnerable household.",
  "Keep the opening cast focused on these three named characters. Other residents may remain unnamed groups unless the plot truly requires otherwise. No supernatural explanation, secret omniscient mastermind, convenient confession, or coincidence-based solution.",
  "The evidence chain must be documentary and traceable: each discovery should follow from a record, date, signature, copy, or access decision that the protagonist could realistically obtain. Distinguish what each character knows and when they learn it.",
  "The central choice is morally costly: exposing the falsified record may invalidate money on which an innocent household now depends, while concealing it perpetuates a system that denied relief to others. Resolve the central mystery by chapter five through causal evidence and a credible decision, not by an unexplained revelation.",
].join("\n\n");

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function safeText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readUsage(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = finiteNumber(usage.input ?? usage.promptTokens);
  const completionTokens = finiteNumber(usage.output ?? usage.completionTokens);
  const reportedTotal = finiteNumber(usage.totalTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal || promptTokens + completionTokens,
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readToolCalls(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  return content
    .filter((part) => part && part.type === "toolCall")
    .map((part) => ({
      name: part.name ?? null,
      arguments: parseMaybeJson(part.arguments ?? part.input),
    }));
}

function readTextPreview(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const text = content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  return text ? safeText(text.slice(0, 1000)) : null;
}

function serializeError(error) {
  const chain = [];
  let current = error;

  for (let index = 0; current && index < 5; index += 1) {
    chain.push({
      name: current.name ?? "Error",
      code: current.code ?? null,
      message: safeText(current.message ?? current),
      resultTool: current.resultTool ?? null,
      attempts: current.attempts ?? null,
      stopReason: current.stopReason ?? null,
      lastAssistantText: current.lastAssistantText
        ? safeText(String(current.lastAssistantText).slice(0, 1000))
        : null,
    });
    current = current.cause;
  }

  return { chain };
}

function gitValue(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function sumUsage(items) {
  const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, observedResponses: 0 };
  for (const item of items) {
    if (!item) continue;
    totals.promptTokens += item.promptTokens;
    totals.completionTokens += item.completionTokens;
    totals.totalTokens += item.totalTokens;
    totals.observedResponses += 1;
  }
  return totals;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/g1-architect-dry-run.mjs --model <allowlisted-free-id> [--project-root <path>] [--report-dir <path>]");
    console.log("Allowed models: " + Array.from(ALLOWED_MODELS).join(", "));
    return;
  }

  const modelId = readArg("--model", process.env.INKOS_G1_MODEL);
  if (!modelId || !ALLOWED_MODELS.has(modelId)) {
    throw new Error(
      "Pass --model with one of the three allowlisted :free IDs: " + Array.from(ALLOWED_MODELS).join(", "),
    );
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(scriptPath), "..");
  const projectRoot = resolve(
    readArg("--project-root", process.env.INKOS_PROJECT_ROOT || DEFAULT_PROJECT_ROOT),
  );
  const reportDir = resolve(
    readArg("--report-dir", process.env.INKOS_G1_REPORT_DIR || DEFAULT_REPORT_DIR),
  );

  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // The guard applies only to this Node process; no environment file is edited.
  process.env.INKOS_OPENROUTER_FREE_ONLY = "1";

  const projectConfig = await loadProjectConfig(projectRoot, {
    requireApiKey: true,
    consumer: "studio",
  });
  const sourceLLM = projectConfig.llm;

  if (sourceLLM.service !== "openrouter") {
    throw new Error("Studio project service must be openrouter; found " + sourceLLM.service);
  }
  if (sourceLLM.provider !== "openai") {
    throw new Error("OpenRouter Responses qualification requires provider=openai; found " + sourceLLM.provider);
  }
  if (new URL(sourceLLM.baseUrl).origin !== "https://openrouter.ai") {
    throw new Error("Studio project must use the official https://openrouter.ai endpoint.");
  }
  if (sourceLLM.apiFormat !== "responses") {
    throw new Error("This qualification requires apiFormat=responses; found " + sourceLLM.apiFormat);
  }
  if (!sourceLLM.apiKey) {
    throw new Error("Studio OpenRouter API key is unavailable; no request was sent.");
  }

  const forbiddenExtra = ["models", "route", "plugins"].filter((key) =>
    Object.prototype.hasOwnProperty.call(sourceLLM.extra ?? {}, key),
  );
  if (forbiddenExtra.length > 0) {
    throw new Error("Free-only guard rejects these configured OpenRouter extra fields: " + forbiddenExtra.join(", "));
  }

  // Force the unused base route to the free router and pin Architect in memory.
  // Other persistent Studio modelOverrides are deliberately not copied.
  const baseLLM = {
    ...sourceLLM,
    model: "openrouter/free",
    maxTokens: MAX_OUTPUT_TOKENS,
  };
  const baseClient = createLLMClient(baseLLM);

  const runner = new PipelineRunner({
    client: baseClient,
    model: "openrouter/free",
    projectRoot,
    modelOverrides: {
      architect: {
        model: modelId,
        maxTokens: MAX_OUTPUT_TOKENS,
      },
    },
  });

  const architectContext = runner.createAgentContext("architect");
  const piModel = architectContext.client._piModel;

  if (
    architectContext.model !== modelId ||
    !piModel ||
    (piModel.id !== modelId && piModel.name !== modelId) ||
    piModel.api !== "openai-responses" ||
    !architectContext.client._apiKey ||
    architectContext.client.service !== "openrouter" ||
    architectContext.client.apiFormat !== "responses"
  ) {
    throw new Error("In-memory Architect model override did not resolve to the requested OpenRouter Responses model.");
  }

  const preflight = {
    requestedModel: modelId,
    resolvedModel: architectContext.model,
    piModelId: piModel.id,
    piModelName: piModel.name,
    piApi: piModel.api,
    service: architectContext.client.service,
    apiFormat: architectContext.client.apiFormat,
    hasKey: Boolean(architectContext.client._apiKey),
    maxTokens: architectContext.client.defaults.maxTokens,
    freeOnly: process.env.INKOS_OPENROUTER_FREE_ONLY === "1",
  };

  console.log("PREFLIGHT PASS");
  console.log(JSON.stringify(preflight, null, 2));

  const profile = createBuiltInWorkProfileRegistry(projectRoot).require("longform-novel");
  const now = new Date().toISOString();
  const book = BookConfigSchema.parse({
    id: "g1-architect-dry-run-" + runId.slice(0, 8),
    title: "The Glass Ledger",
    platform: "other",
    genre: "social mystery",
    status: "incubating",
    targetChapters: 5,
    chapterWordCount: 1350,
    language: "en",
    narrativeLanguage: "ru",
    createdAt: now,
    updatedAt: now,
  });

  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, timeoutSignal]);

  const calls = new Map();
  const evidence = {
    skillIds: [],
    invalidResults: [],
  };
  let unknownCallIndex = 0;
  let preparedRequests = 0;
  let requestCapHit = false;

  function ensureCall(id) {
    const key = typeof id === "string" && id ? id : "untracked-" + (++unknownCallIndex);
    if (!calls.has(key)) {
      calls.set(key, {
        id: key,
        model: null,
        toolNames: [],
        api: null,
        parameters: null,
        preparedRequests: 0,
        completed: [],
        retries: [],
        startedAt: null,
        preparedAt: [],
      });
    }
    return calls.get(key);
  }

  function recordEvidence(type, payload) {
    const data = payload && typeof payload === "object" ? payload : {};

    if (type === "model-call-started") {
      const trace = data.trace && typeof data.trace === "object" ? data.trace : {};
      const call = ensureCall(trace.modelCallId);
      const context = data.context && typeof data.context === "object" ? data.context : {};
      const tools = Array.isArray(context.tools) ? context.tools : [];

      call.model = data.model ?? call.model;
      call.startedAt = new Date().toISOString();
      call.toolNames = tools
        .map((tool) => tool?.name)
        .filter((name) => typeof name === "string" && name.length > 0);

      console.log(
        "[CALL START] stage=" + (call.toolNames.join("|") || "unknown") +
        " model=" + (call.model || "unknown") +
        " id=" + call.id,
      );
      // Stop before preparing request 13; the request cap is per model run.
      if (preparedRequests >= MAX_PREPARED_REQUESTS && !requestCapHit) {
        requestCapHit = true;
        controller.abort(new Error("G1 Architect dry-run exceeded the prepared-request cap."));
      }
      return;
    }

    if (type === "model-request-prepared") {
      const call = ensureCall(data.modelCallId);
      call.model = data.model ?? call.model;
      call.api = data.api ?? call.api;
      call.parameters = data.parameters ?? call.parameters;
      call.preparedRequests += 1;
      call.preparedAt.push(new Date().toISOString());
      preparedRequests += 1;

      console.log(
        "[REQUEST PREPARED] " + preparedRequests + "/" + MAX_PREPARED_REQUESTS +
        " stage=" + (call.toolNames.join("|") || "unknown") +
        " api=" + (call.api || "unknown"),
      );

      if (preparedRequests > MAX_PREPARED_REQUESTS && !requestCapHit) {
        requestCapHit = true;
        controller.abort(new Error("G1 Architect dry-run exceeded the prepared-request cap."));
      }
      return;
    }

    if (type === "model-call-completed") {
      const call = ensureCall(data.modelCallId);
      const response = data.response && typeof data.response === "object" ? data.response : {};
      const completion = {
        completedAt: new Date().toISOString(),
        status: data.status ?? null,
        reportedModel: response.model ?? null,
        reportedProvider: response.provider ?? null,
        reportedApi: response.api ?? null,
        stopReason: response.stopReason ?? null,
        errorCode: response.errorCode ?? null,
        errorMessage: response.errorMessage ? safeText(response.errorMessage) : null,
        usage: readUsage(response),
        toolCalls: readToolCalls(response),
        textPreview: readTextPreview(response),
      };

      call.completed.push(completion);
      console.log(
        "[CALL COMPLETE] stage=" + (call.toolNames.join("|") || "unknown") +
        " status=" + (completion.status || "unknown") +
        " stop=" + (completion.stopReason || "unknown") +
        " tool=" + (completion.toolCalls.map((item) => item.name).filter(Boolean).join("|") || "none"),
      );
      return;
    }

    if (type === "model-call-retry") {
      const call = ensureCall(data.modelCallId);
      call.retries.push({ reason: data.reason ?? "unknown" });
      console.log("[RETRY] stage=" + (call.toolNames.join("|") || "unknown") + " reason=" + (data.reason || "unknown"));
      return;
    }

    if (type === "skills-applied") {
      const skills = Array.isArray(data.skills) ? data.skills : [];
      evidence.skillIds = Array.from(new Set([
        ...evidence.skillIds,
        ...skills.map((skill) => skill?.id).filter((id) => typeof id === "string"),
      ]));
      return;
    }

    if (type === "worker-result-invalid") {
      evidence.invalidResults.push({
        code: data.code ?? null,
        resultTool: data.resultTool ?? null,
        message: data.message ? safeText(data.message) : null,
        issues: Array.isArray(data.issues) ? data.issues.slice(0, 12) : [],
      });
    }
  }

  let outline = null;
  let result = null;
  let error = null;

  try {
    result = await withExecutionEvidence(
      recordEvidence,
      () => runWithAgentTrajectory(
        {
          conversationId: opaqueConversationId(runId),
          runId,
          agentRole: "main",
        },
        () => runner.runWithAbortSignal(signal, async () => {
          const architect = new ArchitectAgent(runner.createAgentContext("architect"));
          // Deliberately call only the pure generation method. No initBook(),
          // writeFoundationFiles(), or Studio Work/Episode is involved.
          return architect.generateFoundation(book, SYNTHETIC_BRIEF, undefined, {
            onOutline: (value) => {
              outline = value;
            },
          });
        }),
      ),
      profile,
      null,
    );
  } catch (caught) {
    error = serializeError(caught);
  }

  const callList = Array.from(calls.values());
  const stageSummary = EXPECTED_STAGES.map((stage) => {
    const related = callList.filter((call) =>
      call.toolNames.includes(stage) ||
      call.completed.some((completion) => completion.toolCalls.some((tool) => tool.name === stage)),
    );
    const completions = related.flatMap((call) => call.completed);
    const retries = related.flatMap((call) => call.retries);
    return {
      stage,
      attempts: related.length,
      preparedRequests: related.reduce((sum, call) => sum + call.preparedRequests, 0),
      completedResponses: completions.length,
      retryEvents: retries.length,
      acceptedToolCall: completions.some((completion) =>
        completion.toolCalls.some((tool) => tool.name === stage),
      ),
      usage: sumUsage(completions.map((completion) => completion.usage)),
    };
  });

  const allCompletions = callList.flatMap((call) => call.completed);
  const totalUsage = sumUsage(allCompletions.map((completion) => completion.usage));
  const roles = Array.isArray(result?.roles) ? result.roles : [];
  const roleNames = roles.map((role) => String(role?.name ?? "").trim()).filter(Boolean);

  const validation = {
    storyFramePresent: typeof result?.storyFrame === "string" && result.storyFrame.trim().length > 0,
    volumeMapPresent: typeof result?.volumeMap === "string" && result.volumeMap.trim().length > 0,
    bookRulesPresent: typeof result?.bookRules === "string" && result.bookRules.trim().length > 0,
    bookRulesDataPresent: Boolean(result?.bookRulesData && typeof result.bookRulesData === "object"),
    atLeastOneRole: roles.length > 0,
    allRolesHaveNamesAndCards: roles.every((role) =>
      typeof role?.name === "string" && role.name.trim().length > 0 &&
      typeof role?.content === "string" && role.content.trim().length > 0,
    ),
    uniqueRoleNames: new Set(roleNames.map((name) => name.toLocaleLowerCase("en"))).size === roleNames.length,
    initialHooksArrayPresent: Array.isArray(result?.initialHooks),
  };

  const outputValid = Object.values(validation).every(Boolean);
  const stageEvidenceComplete = stageSummary.every((stage) => stage.acceptedToolCall);

  let status = "FAIL";
  if (outputValid && !error) status = "PASS";
  else if (requestCapHit) status = "REQUEST_CAP_EXCEEDED";
  else if (timeoutSignal.aborted) status = "TIMEOUT";
  else if (signal.aborted) status = "ABORTED";

  const finishedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt,
    source: {
      branch: gitValue(repoRoot, ["branch", "--show-current"]),
      head: gitValue(repoRoot, ["rev-parse", "HEAD"]),
    },
    model: preflight,
    limits: {
      maxOutputTokensPerStage: MAX_OUTPUT_TOKENS,
      maxPreparedRequests: MAX_PREPARED_REQUESTS,
      timeoutMs: TIMEOUT_MS,
    },
    profile: {
      id: profile.id,
      requiredSkillIds: profile.requiredSkillIds,
      recommendedSkillIds: profile.recommendedSkillIds,
      appliedSkillIds: evidence.skillIds,
    },
    book: {
      id: book.id,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      targetChapters: book.targetChapters,
      chapterWordCount: book.chapterWordCount,
      language: book.language,
      narrativeLanguage: book.narrativeLanguage,
    },
    languageNote: "ArchitectAgent.generateFoundation currently selects its prompt language from book.language. This run uses operational English with narrativeLanguage=ru; it tests the real four-stage Architect protocol, not Russian prose quality.",
    passDefinition: "PASS means generateFoundation returned a non-empty, schema-accepted foundation with the expected output fields. It is not a judgment of literary quality or Russian prose.",
    servingNote: "reportedProvider/reportedModel are values exposed by the model response, not guaranteed OpenRouter serving metadata. Match call timestamps with OpenRouter Activity for actual provider, serving ID, and cost.",
    usageNote: "Usage sums every observed model-call-completed response, including failed/retried attempts when the provider returned usage. It is token usage, not price.",
    syntheticBrief: SYNTHETIC_BRIEF,
    status,
    validation,
    stageEvidenceComplete,
    stageSummary,
    usage: totalUsage,
    preparedRequests,
    retries: callList.reduce((sum, call) => sum + call.retries.length, 0),
    outline,
    result,
    calls: callList,
    invalidResults: evidence.invalidResults,
    error,
  };

  let reportPath = null;
  let reportWriteError = null;
  try {
    await mkdir(reportDir, { recursive: true });
    const stamp = finishedAt.replace(/[:.]/g, "-");
    const modelSlug = modelId.replace(/[^A-Za-z0-9.-]+/g, "-");
    reportPath = join(reportDir, stamp + "-" + modelSlug + ".json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch (writeError) {
    reportWriteError = safeText(writeError?.message ?? writeError);
  }

  console.log("RESULT: " + status);
  console.log("STAGE EVIDENCE COMPLETE: " + String(stageEvidenceComplete));
  console.log("PREPARED REQUESTS: " + preparedRequests + "/" + MAX_PREPARED_REQUESTS);
  console.log("USAGE: " + JSON.stringify(totalUsage));
  for (const stage of stageSummary) {
    console.log(
      "STAGE " + stage.stage +
      ": accepted=" + String(stage.acceptedToolCall) +
      ", attempts=" + stage.attempts +
      ", prepared=" + stage.preparedRequests +
      ", retries=" + stage.retryEvents,
    );
  }
  if (error) console.log("ERROR: " + JSON.stringify(error));
  if (reportPath) console.log("REPORT: " + reportPath);
  if (reportWriteError) {
    console.error("REPORT WRITE FAIL: " + reportWriteError);
    process.exitCode = 2;
  }

  if (status !== "PASS" && process.exitCode !== 2) process.exitCode = 1;
}

main().catch((error) => {
  console.error("PREFLIGHT FAIL");
  console.error(safeText(error?.message ?? error));
  process.exitCode = 2;
});
