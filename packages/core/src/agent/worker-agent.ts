import { Agent } from "@mariozechner/pi-agent-core";
import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  chatCompletion,
  assertOpenRouterFreeOnly,
  clientWithModel,
  clampTemperatureForModel,
  createStreamMonitor,
  type LLMClient,
  type LLMMessage,
  type LLMResponse,
  type OnStreamProgress,
} from "../llm/provider.js";
import { guardedPiNonStreaming, guardedPiStream } from "./pi-stream.js";
import { singleAttemptStream } from "./single-attempt-stream.js";
import { toPiApi } from "../llm/api-format.js";
import { recordExecutionEvidence } from "../harness/execution-evidence.js";
import {decodeStructuredFields} from './structured-arguments.js';
import { preserveToolArgumentTypes, toolArgumentIssues } from "./tool-arguments.js";
import { archiveWorkerResponse, findArchivedWorkerResponse, markWorkerResponseArchive, type WorkerResponseArchiveContext } from "./worker-response-archive.js";
import { currentChapterStage } from "./chapter-stage-context.js";
import { MAX_MODEL_OUTPUT_TOKENS } from "../llm/token-limits.js";

export interface WorkerAgentOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly webSearch?: boolean;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onTextDelta?: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: LLMResponse["usage"]) => void;
  /** Durable location for raw worker outputs; saved before returning or validating tool arguments. */
  readonly responseArchive?: WorkerResponseArchiveContext;
  /** Avoid another paid generation after an invalid or empty result. */
  readonly disableRetries?: boolean;
}

export interface WorkerResultTool<TParameters extends TSchema> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly validate?: (parameters: Static<TParameters>) => Static<TParameters> | Promise<Static<TParameters>>;
}

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function workerModel(client: LLMClient, modelId: string, maxTokens?: number): Model<Api> {
  const base = client._piModel;
  if (base) {
    return base.id === modelId || base.name === modelId ? base : clientWithModel(client, modelId)._piModel!;
  }

  // Test doubles and embedders may provide only the public LLMClient surface.
  // The actual transport still runs through chatCompletion; this model is Pi
  // lifecycle metadata rather than a second provider configuration.
  return {
    id: modelId,
    name: modelId,
    api: toPiApi(client.apiFormat),
    provider: client.provider as Provider,
    baseUrl: "",
    reasoning: client.defaults?.reasoning ?? ((client.defaults?.thinkingBudget ?? 0) > 0),
    input: ["text"],
    cost: EMPTY_COST,
    contextWindow: 200_000,
    maxTokens: Math.min(maxTokens ?? client.defaults?.maxTokens ?? MAX_MODEL_OUTPUT_TOKENS, MAX_MODEL_OUTPUT_TOKENS),
  };
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...EMPTY_COST, total: 0 },
  };
}

function assistantMessage(
  model: Model<Api>,
  content: string,
  response: LLMResponse | undefined,
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: response?.usage
      ? {
          input: response.usage.promptTokens,
          output: response.usage.completionTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: response.usage.totalTokens,
          cost: { ...EMPTY_COST, total: 0 },
        }
      : emptyUsage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function localStopStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(model, "", undefined, "stop");
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function replayStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end(message);
  });
  return stream;
}

function failedLocalStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
  return replayStream(assistantMessage(model, "", undefined, "error", String(error)));
}

async function chapterRequest(context: Context, archive: WorkerResponseArchiveContext | undefined, resultTool?: string): Promise<{
  archive?: WorkerResponseArchiveContext; replay?: { path: string; response: AssistantMessage };
}> {
  const stage = currentChapterStage();
  if (!stage) return { archive };
  if (!archive || archive.workId !== stage.bookId) throw Object.assign(new Error("Chapter worker response archive is required"), { code: "CHAPTER_RESPONSE_ARCHIVE_REQUIRED" });
  const messages = context.messages.map(message => ({ role: message.role, content: message.content,
    ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}) }));
  const fingerprint = createHash("sha256").update(JSON.stringify({ systemPrompt: context.systemPrompt, messages, tools: context.tools, resultTool })).digest("hex");
  const request = await stage.beginRequest(fingerprint);
  const requestArchive = { ...archive, requestFingerprint: fingerprint, requestSequence: request.sequence, ...(resultTool ? { resultTool } : {}) };
  if (!request.replay) return { archive: requestArchive };
  const replay = await findArchivedWorkerResponse({ context: requestArchive, operationId: stage.operationId,
    chapterNumber: stage.chapterNumber, stage: stage.stage, attemptId: stage.attemptId,
    requestSequence: request.sequence, requestFingerprint: fingerprint });
  if (!replay) throw Object.assign(new Error(`The prior ${stage.stage} request has no complete archived response`), {
    code: "CHAPTER_RESUME_AMBIGUOUS_STAGE", stage: stage.stage, chapterNumber: stage.chapterNumber,
  });
  return { archive: requestArchive, replay };
}

/** Archive a structured worker's complete response before Pi validates tool arguments. */
function archiveResponseStream(
  source: AssistantMessageEventStream,
  model: Model<Api>,
  context: WorkerResponseArchiveContext,
  attempt: number,
  onArchived: (response: AssistantMessage, path: string) => void,
  onArchiveFailure: (error: unknown) => void,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "done" || event.type === "error") {
          const response = event.type === "done" ? event.message : event.error;
          let path: string;
          try {
            path = await archiveWorkerResponse({ context, model, response, attempt });
          } catch (error) {
            onArchiveFailure(error);
            const failure = assistantMessage(model, "", undefined, "error", `Could not archive the raw worker response: ${String(error)}`);
            output.push({ type: "error", reason: "error", error: failure });
            output.end(failure);
            return;
          }
          onArchived(response, path);
        }
        output.push(event);
        if (event.type === "done") { output.end(event.message); return; }
        if (event.type === "error") { output.end(event.error); return; }
      }
      const failure = assistantMessage(model, "", undefined, "error", "Worker response stream ended without a final response.");
      output.push({ type: "error", reason: "error", error: failure });
      output.end(failure);
    } catch (error) {
      const failure = assistantMessage(model, "", undefined, "error", String(error));
      output.push({ type: "error", reason: "error", error: failure });
      output.end(failure);
    }
  })();
  return output;
}

function textFromContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function contextMessages(context: Context): LLMMessage[] {
  const messages: LLMMessage[] = [];
  if (context.systemPrompt?.trim()) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textFromContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content
          .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      });
      continue;
    }
    messages.push({
      role: "user",
      content: `[Tool result: ${message.toolName}]\n${textFromContent(message.content)}`,
    });
  }
  return messages;
}

function combineSignals(primary: AbortSignal | undefined, secondary: AbortSignal | undefined): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return AbortSignal.any([primary, secondary]);
}

/**
 * Pi stream adapter backed by the existing InkOS provider boundary.
 *
 * Pi owns the worker lifecycle and cancellation. The provider remains the sole
 * transport implementation so custom endpoints, retries, context guards and
 * stream deadlines behave exactly like the rest of InkOS.
 */
function providerWorkerStream(
  client: LLMClient,
  model: Model<Api>,
  context: Context,
  streamOptions: SimpleStreamOptions | undefined,
  options: WorkerAgentOptions,
  onFailure: (error: unknown) => void,
) {
  const stream = createAssistantMessageEventStream();
  let streamedText = "";
  let started = false;

  const partial = (): AssistantMessage => assistantMessage(model, streamedText, undefined, "stop");
  const emitDelta = (delta: string): void => {
    if (!delta) return;
    options.onTextDelta?.(delta);
    if (!started) {
      stream.push({ type: "start", partial: partial() });
      stream.push({ type: "text_start", contentIndex: 0, partial: partial() });
      started = true;
    }
    streamedText += delta;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: partial() });
  };

  queueMicrotask(() => {
    void (async () => {
      try {
        const signal = combineSignals(streamOptions?.signal, options.signal);
        const response = await chatCompletion(client, model.id, contextMessages(context), {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.webSearch !== undefined ? { webSearch: options.webSearch } : {}),
          ...(options.onStreamProgress ? { onStreamProgress: options.onStreamProgress } : {}),
          onTextDelta: emitDelta,
          ...(signal ? { signal } : {}),
        });
        if (started) {
          streamedText = response.content;
          stream.push({ type: "text_end", contentIndex: 0, content: response.content, partial: partial() });
        }
        const message = assistantMessage(model, response.content, response, "stop");
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      } catch (error) {
        onFailure(error);
        const aborted = streamOptions?.signal?.aborted || options.signal?.aborted;
        const message = assistantMessage(
          model,
          streamedText,
          undefined,
          aborted ? "aborted" : "error",
          error instanceof Error ? error.message : String(error),
        );
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
        stream.end(message);
      }
    })();
  });

  return stream;
}

function toAgentMessages(messages: ReadonlyArray<LLMMessage>, model: Model<Api>): Message[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message): Message => {
      if (message.role === "user") {
        return { role: "user", content: message.content, timestamp: Date.now() };
      }
      return assistantMessage(model, message.content, undefined, "stop");
    });
}

export async function runWorkerAgent(
  client: LLMClient,
  modelId: string,
  messages: ReadonlyArray<LLMMessage>,
  options: WorkerAgentOptions = {},
): Promise<LLMResponse> {
  options.signal?.throwIfAborted();
  const model = workerModel(client, modelId, options.maxTokens);
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const promptMessages = toAgentMessages(messages, model);
  if (promptMessages.length === 0) {
    throw new Error("Worker Agent requires at least one non-system message");
  }

  let streamFailure: unknown;
  let chapterReplayFailure: unknown;
  let responseArchive = options.responseArchive;
  let replayedResponse = false;
  const agent = new Agent({
    initialState: { model, systemPrompt, tools: [], messages: [] },
    toolExecution: "sequential",
    streamFn: async (streamModel, context, streamOptions) => {
      let request: Awaited<ReturnType<typeof chapterRequest>>;
      try { request = await chapterRequest(context, options.responseArchive); }
      catch (error) { chapterReplayFailure = error; return failedLocalStream(streamModel, error); }
      responseArchive = request.archive;
      if (request.replay) { replayedResponse = true; return replayStream(request.replay.response); }
      return providerWorkerStream(client, streamModel, context, streamOptions, options,
        (error) => { streamFailure = error; });
    },
  });
  const abortAgent = () => agent.abort();
  options.signal?.addEventListener("abort", abortAgent, { once: true });

  try {
    await agent.prompt(promptMessages);
    if (chapterReplayFailure !== undefined) throw chapterReplayFailure;
    const final = [...agent.state.messages].reverse().find(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    if (final && responseArchive && !replayedResponse) {
      const artifactPath = await archiveWorkerResponse({ context: responseArchive, model, response: final, attempt: 1 });
      recordExecutionEvidence("worker-response-archived", { artifactPath, role: responseArchive.role, model: model.id });
    }
    options.signal?.throwIfAborted();
    if (streamFailure !== undefined) throw streamFailure;
    if (!final) throw new Error("Worker Agent completed without an assistant response");
    if (final.stopReason === "error" || final.stopReason === "aborted") {
      throw Object.assign(new Error(final.errorMessage ?? `Worker Agent stopped: ${final.stopReason}`), {
        code: (final as AssistantMessage & { errorCode?: string }).errorCode ?? "WORKER_MODEL_ERROR",
      });
    }
    return {
      content: final.content
        .filter((part): part is Extract<(typeof final.content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join(""),
      usage: {
        promptTokens: final.usage.input,
        completionTokens: final.usage.output,
        totalTokens: final.usage.totalTokens,
      },
    };
  } finally {
    options.signal?.removeEventListener("abort", abortAgent);
  }
}

/**
 * Run a worker whose result is host-consumed state rather than prose.
 * The model must submit validated arguments through one Pi tool; the host owns
 * the tool result and never scrapes JSON out of assistant text.
 */
export async function runWorkerAgentTool<TParameters extends TSchema>(
  client: LLMClient,
  modelId: string,
  messages: ReadonlyArray<LLMMessage>,
  resultTool: WorkerResultTool<TParameters>,
  options: WorkerAgentOptions = {},
): Promise<Static<TParameters>> {
  options.signal?.throwIfAborted();
  if (!client._piModel) {
    throw new Error("Structured worker tools require a resolved Pi model");
  }
  if (client._piModel.id !== modelId && client._piModel.name !== modelId) client = clientWithModel(client, modelId);
  const model = workerModel(client, modelId, options.maxTokens);
  assertOpenRouterFreeOnly({ service: client.service, baseUrl: model.baseUrl, model: modelId, extra: client.defaults.extra });
  assertOpenRouterFreeOnly({ service: client.service, baseUrl: model.baseUrl, model: model.id, extra: client.defaults.extra });
  const systemPrompt = [
    ...messages.filter((message) => message.role === "system").map((message) => message.content),
    `Finish by calling ${resultTool.name} exactly once. Do not print the result as prose or JSON.`,
  ].join("\n\n");
  const promptMessages = toAgentMessages(messages, model);
  if (promptMessages.length === 0) {
    throw new Error("Structured Worker Agent requires at least one non-system message");
  }

  let submitted: Static<TParameters> | undefined;
  let modelTurns = 0;
  let resultAttemptsExhausted = false;
  let lastValidationError: (Error & {code?:string}) | undefined;
  let activeResponseArtifactPath: string | undefined;
  let responseArchiveFailure: unknown;
  let chapterReplayFailure: unknown;
  const responseArtifactPaths: string[] = [];
  const resultArtifactByToolCall = new Map<string, string>();
  const maxResultTurns = options.disableRetries ? 1 : 3;
  const monitor = createStreamMonitor(progress => {
    options.onStreamProgress?.(progress);
    recordExecutionEvidence("model-stream-progress", { resultTool: resultTool.name, ...progress });
  });
  const { validate, ...toolDefinition } = resultTool;
  const tool: AgentTool<TParameters, Static<TParameters>> = {
    ...toolDefinition,
    prepareArguments: (params) => {
      const decodedPaths:string[]=[];
      params=decodeStructuredFields(resultTool.parameters,params,decodedPaths) as typeof params;
      if(decodedPaths.length)recordExecutionEvidence('worker-arguments-decoded',{resultTool:resultTool.name,paths:decodedPaths});
      const issues = toolArgumentIssues(resultTool.parameters, params);
      if (issues.length) {
        const failure={code:'WORKER_SCHEMA_INVALID',resultTool:resultTool.name,issues,artifactPath:activeResponseArtifactPath};
        recordExecutionEvidence('worker-result-invalid',failure);
        lastValidationError=undefined;
        throw new Error(JSON.stringify(failure));
      }
      return params as Static<TParameters>;
    },
    execute: async (_toolCallId, params): Promise<AgentToolResult<Static<TParameters>>> => {
      const parsed = Value.Parse(resultTool.parameters, params) as Static<TParameters>;
      try {
        submitted = validate ? await validate(parsed) : parsed;
        if (activeResponseArtifactPath) await markWorkerResponseArchive(activeResponseArtifactPath,
          { stage: "domain", status: "passed" });
      } catch(error) {
        lastValidationError=error instanceof Error?error:new Error(String(error));
        recordExecutionEvidence('worker-result-invalid',{
          code:lastValidationError.code??'WORKER_DOMAIN_INVALID',
          resultTool:resultTool.name,
          message:lastValidationError.message,
          artifactPath:activeResponseArtifactPath,
        });
        if (activeResponseArtifactPath) await markWorkerResponseArchive(activeResponseArtifactPath,
          { stage: "domain", status: "failed", code: lastValidationError.code, message: lastValidationError.message });
        throw error;
      }
      return {
        content: [{ type: "text", text: "Structured result received by the host." }],
        details: submitted,
      };
    },
  };
  const agent = new Agent({
    initialState: { model, systemPrompt, tools: [tool], messages: [] },
    beforeToolCall: async (context) => {
      activeResponseArtifactPath = resultArtifactByToolCall.get(context.toolCall.id);
      try {
        await preserveToolArgumentTypes(context);
        if (activeResponseArtifactPath) await markWorkerResponseArchive(activeResponseArtifactPath,
          { stage: "schema", status: "passed" });
      } catch (error) {
        if (activeResponseArtifactPath) await markWorkerResponseArchive(activeResponseArtifactPath,
          { stage: "schema", status: "failed", code: (error as {code?:string})?.code, message: String(error) });
        throw error;
      }
      return undefined;
    },
    toolExecution: "sequential",
    streamFn: async (streamModel, context, streamOptions) => {
      if (submitted) return localStopStream(streamModel);
      if (modelTurns >= maxResultTurns) {
        resultAttemptsExhausted = true;
        return localStopStream(streamModel);
      }
      modelTurns++;
      let request: Awaited<ReturnType<typeof chapterRequest>>;
      try { request = await chapterRequest(context, options.responseArchive, resultTool.name); }
      catch (error) { chapterReplayFailure = error; return failedLocalStream(streamModel, error); }
      if (request.replay) {
        const { response, path } = request.replay;
        responseArtifactPaths.push(path);
        for (const part of response.content) if (part.type === "toolCall") resultArtifactByToolCall.set(part.id, path);
        activeResponseArtifactPath = path;
        return replayStream(response);
      }
      const resultOptions = {
          ...streamOptions,
          ...(options.temperature !== undefined ? { temperature: client.service === "custom" ? options.temperature
            : clampTemperatureForModel(client.service, modelId, options.temperature) } : {}),
          maxTokens: Math.min(options.maxTokens ?? client.defaults.maxTokens, streamModel.maxTokens),
          signal: combineSignals(streamOptions?.signal, options.signal),
          // There is exactly one result tool, so required selects it without a
          // provider-specific named-function envelope.
          toolChoice: "required" as const,
          onPayload: (payload: unknown) => payload && typeof payload === "object" ? { ...client.defaults.extra, ...payload } : payload,
        };
      const rawStream = options.disableRetries
        ? singleAttemptStream(streamModel, context, resultOptions, client.proxyUrl, client.stream !== false, monitor.onChunk)
        : client.stream === false
        ? guardedPiNonStreaming(streamModel, context, resultOptions, client.proxyUrl)
        : guardedPiStream(streamModel, context, resultOptions, 0, {firstEventTimeoutMs:900_000,idleTimeoutMs:1_000_000}, false);
      return request.archive ? archiveResponseStream(rawStream, streamModel, request.archive, modelTurns,
        (response, artifactPath) => {
          responseArtifactPaths.push(artifactPath);
          for (const part of response.content) if (part.type === "toolCall") resultArtifactByToolCall.set(part.id, artifactPath);
          activeResponseArtifactPath = artifactPath;
          recordExecutionEvidence("worker-response-archived", { artifactPath, role: options.responseArchive!.role,
            model: streamModel.id, resultTool: resultTool.name, attempt: modelTurns });
        }, error => { responseArchiveFailure = error; agent.abort(); }) : rawStream;
    },
    getApiKey: () => client._apiKey,
  });
  const abortAgent = () => agent.abort();
  options.signal?.addEventListener("abort", abortAgent, { once: true });
  const unsubscribeProgress = agent.subscribe(event => {
    if (event.type !== "message_update" || (options.disableRetries && client.stream !== false)) return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" || update.type === "toolcall_delta") monitor.onChunk(update.delta);
  });
  const collectUsage = () => {
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    for (const message of agent.state.messages.slice(promptMessages.length)) {
      if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
      usage.promptTokens += count(message.usage?.input);
      usage.completionTokens += count(message.usage?.output);
      usage.totalTokens += count(message.usage?.totalTokens);
    }
    return usage;
  };

  try {
    await agent.prompt(promptMessages);
    if (chapterReplayFailure !== undefined) throw chapterReplayFailure;
    if (responseArchiveFailure !== undefined) throw Object.assign(new Error("Could not preserve the raw worker response before processing."), {
      code: "WORKER_RESPONSE_ARCHIVE_FAILED", cause: responseArchiveFailure,
    });
    options.signal?.throwIfAborted();
    if (resultAttemptsExhausted) throw Object.assign(new Error(lastValidationError?.message??'Structured result remained invalid after bounded correction attempts'), {
      code:lastValidationError?.code??'WORKER_RESULT_INVALID',resultTool:resultTool.name,attempts:modelTurns,
      artifactPaths:responseArtifactPaths,
      lastToolError:[...agent.state.messages].reverse().find(message=>message.role==='toolResult'&&message.isError),
    });
    const initialResult = agent.state.messages.at(-1);
    if (initialResult?.role === "assistant" && initialResult.stopReason === "length") {
      throw Object.assign(new Error("Worker output reached the configured model output limit"), {
        code: "MODEL_OUTPUT_LIMIT", resultTool: resultTool.name, stopReason: initialResult.stopReason, artifactPaths: responseArtifactPaths,
      });
    }
    if (!submitted && initialResult?.role === "assistant" && initialResult.stopReason === "error") {
      throw Object.assign(new Error(initialResult.errorMessage ?? "Worker model request failed"), {
        code: (initialResult as AssistantMessage & { errorCode?: string }).errorCode ?? "WORKER_MODEL_ERROR",
        resultTool: resultTool.name, stopReason: initialResult.stopReason, attempts: modelTurns, artifactPaths: responseArtifactPaths,
      });
    }
    if (!submitted) {
      await agent.prompt(`You did not call ${resultTool.name}. Call it now with the complete result.`);
      if (chapterReplayFailure !== undefined) throw chapterReplayFailure;
      if (responseArchiveFailure !== undefined) throw Object.assign(new Error("Could not preserve the raw worker response before processing."), {
        code: "WORKER_RESPONSE_ARCHIVE_FAILED", cause: responseArchiveFailure,
      });
      options.signal?.throwIfAborted();
    }
    if (!submitted) {
      const last = [...agent.state.messages].reverse().find(
        (message): message is AssistantMessage => message.role === "assistant",
      );
      throw Object.assign(new Error(last?.errorMessage || `Worker Agent completed without calling ${resultTool.name}`), {
        code: (last as (AssistantMessage & { errorCode?: string }) | undefined)?.errorCode
          ?? (resultAttemptsExhausted ? "WORKER_RESULT_INVALID" : last?.stopReason === "length" ? "MODEL_OUTPUT_LIMIT" : "WORKER_RESULT_MISSING"),
        attempts: modelTurns,
        resultTool: resultTool.name,
        stopReason: last?.stopReason,
        artifactPaths: responseArtifactPaths,
        lastToolError: [...agent.state.messages].reverse().find((message)=>message.role==="toolResult"&&message.isError),
        lastAssistantText: last?.content.filter((part)=>part.type==="text").map((part)=>part.text).join(""),
      });
    }
    // Initial prompt messages may themselves include assistant history. Only
    // responses produced by this invocation belong to its usage. The local
    // stop message after a successful tool call carries zero usage.
    const usage = collectUsage();
    if (usage.promptTokens || usage.completionTokens || usage.totalTokens) options.onUsage?.(usage);
    return submitted;
  } catch (error) {
    const usage = collectUsage();
    if (usage.promptTokens || usage.completionTokens || usage.totalTokens) {
      options.onUsage?.(usage);
      if (error instanceof Error) Object.assign(error, { tokenUsage: usage });
    }
    throw error;
  } finally {
    unsubscribeProgress();
    monitor.stop();
    options.signal?.removeEventListener("abort", abortAgent);
  }
}
