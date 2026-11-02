import { recordExecutionEvidence } from "../harness/execution-evidence.js";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@mariozechner/pi-ai";
import { MAX_MODEL_OUTPUT_TOKENS } from "../llm/token-limits.js";
import {
  assertWithinContextWindow,
  createRequestDeadline,
  estimatePiContextTokens,
  guardAssistantMessageStream,
  withTransientLLMRetry,
  type StreamDeadlineOptions,
} from "../llm/provider.js";
import {
  agentTrajectoryHeaders,
  beginAgentModelCall,
} from "../llm/agent-trajectory.js";
import { fetchWithProxy } from "../utils/proxy-fetch.js";

/**
 * The single Pi transport boundary used by both conversational and worker
 * agents. Pi keeps native tool calls; InkOS adds context guards, trajectory
 * headers, cancellation, and stream deadlines around the request.
 */
export function guardedPiStream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  emptyRetries = 0,
  deadlineOptions?: StreamDeadlineOptions,
  retryOnInactivity = false,
): AssistantMessageEventStream {
  const reservedOutputTokens = Math.min(
    Number.isFinite(options?.maxTokens) ? options!.maxTokens! : Number.isFinite(model.maxTokens) ? model.maxTokens : MAX_MODEL_OUTPUT_TOKENS,
    Number.isFinite(model.maxTokens) ? model.maxTokens : MAX_MODEL_OUTPUT_TOKENS,
    MAX_MODEL_OUTPUT_TOKENS,
  );
  const boundedOptions = { ...options, maxTokens: reservedOutputTokens };
  assertWithinContextWindow({
    piModel: model,
    model: model.id,
    estimatedInputTokens: estimatePiContextTokens(context),
    reservedOutputTokens,
  });
  const modelCall = beginAgentModelCall();
  recordExecutionEvidence("model-call-started", { trace: modelCall, model: model.id, context, maxTokens: reservedOutputTokens });
  const traceHeaders = agentTrajectoryHeaders(model.baseUrl, modelCall, 1, {
    effort: String(options?.reasoning ?? (model.reasoning ? "enabled" : "disabled")),
  });
  return observeModelStream(model, modelCall?.modelCallId, guardAssistantMessageStream(
    model,
    (signal) => streamSimple(model, context, {
      ...boundedOptions,
      headers: { ...(boundedOptions.headers ?? {}), ...traceHeaders },
      onPayload: async (payload, activeModel) => {
        let configured = explicitDeepSeekThinkingMode(payload, activeModel);
        const choice = (options as SimpleStreamOptions & { toolChoice?: unknown } | undefined)?.toolChoice;
        if (choice !== undefined && configured && typeof configured === "object") {
          if (activeModel.api === "openai-completions") configured = { ...configured, tool_choice: choice };
          if (activeModel.api === "openai-responses") {
            const forced = choice as { type?: string; function?: { name?: string } };
            configured = { ...configured as Record<string, unknown>, tool_choice: forced?.type === "function" && forced.function?.name
              ? { type: "function", name: forced.function.name } : choice };
          }
          if (activeModel.api === "anthropic-messages") {
            // Native Claude support for forced selection varies by model and
            // thinking mode. Keep its compatible wire default and enforce the
            // requested result contract below, without disabling reasoning.
            // https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
            configured = { ...configured as Record<string, unknown>, tool_choice: { type: choice === "none" ? "none" : "auto" } };
          }
        }
        const prepared = await options?.onPayload?.(configured, activeModel) ?? configured;
        const effectivePayload = applyDefaultReasoningPolicy(prepared, activeModel, options);
        recordExecutionEvidence("model-request-prepared", { modelCallId: modelCall?.modelCallId, model: activeModel.id,
          api: activeModel.api,
          parameters: effectivePayload && typeof effectivePayload === "object" ? Object.fromEntries(Object.entries(effectivePayload).filter(([key]) => ["stream", "reasoning", "reasoning_effort", "thinking", "enable_thinking", "max_tokens", "max_completion_tokens", "max_output_tokens", "tool_choice"].includes(key))) : {} });
        return effectivePayload;
      },
      signal,
    }),
    options?.signal,
    deadlineOptions,
  ), emptyRetries > 0 && !options?.signal?.aborted ? () => guardedPiStream(model, context, options, emptyRetries - 1, deadlineOptions, retryOnInactivity) : undefined,
  (options as SimpleStreamOptions & { toolChoice?: unknown } | undefined)?.toolChoice, retryOnInactivity);
}

/**
 * Non-streaming OpenAI-compatible transport adapted back into Pi events.
 * The Agent and tool loop remain Pi-owned; this only changes the HTTP mode for
 * providers whose streaming endpoint is unavailable or unreliable.
 */
export function guardedPiNonStreaming<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  proxyUrl?: string,
  emptyRetries = 0,
): AssistantMessageEventStream {
  if (model.api !== "openai-completions") return guardedPiStream(model, context, options);
  const reservedOutputTokens = Math.min(
    Number.isFinite(options?.maxTokens) ? options!.maxTokens! : Number.isFinite(model.maxTokens) ? model.maxTokens : MAX_MODEL_OUTPUT_TOKENS,
    Number.isFinite(model.maxTokens) ? model.maxTokens : MAX_MODEL_OUTPUT_TOKENS,
    MAX_MODEL_OUTPUT_TOKENS,
  );
  assertWithinContextWindow({
    piModel: model,
    model: model.id,
    estimatedInputTokens: estimatePiContextTokens(context),
    reservedOutputTokens,
  });
  const eventStream = createAssistantMessageEventStream();
  const output = emptyAssistantMessage(model);
  const modelCall = beginAgentModelCall();
  void (async () => {
    try {
      recordExecutionEvidence("model-call-started", { trace: modelCall, model: model.id, context, maxTokens: reservedOutputTokens });
      const payload: Record<string, unknown> = {
        model: model.id,
        messages: toOpenAIChatMessages(context),
        stream: false,
      };
      if (context.tools?.length) {
        payload.tools = context.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }
      payload.max_tokens = reservedOutputTokens;
      if (options?.temperature !== undefined) payload.temperature = options.temperature;
      const toolChoice = (options as SimpleStreamOptions & { toolChoice?: unknown } | undefined)?.toolChoice;
      if (toolChoice !== undefined) payload.tool_choice = toolChoice;
      const configured = explicitDeepSeekThinkingMode(payload, model);
      const transformed = applyDefaultReasoningPolicy(
        await options?.onPayload?.(configured, model) ?? configured,
        model,
        options,
      );
      const json = await withTransientLLMRetry(async (attempt) => {
        const deadline = createRequestDeadline(options?.signal);
        const traceHeaders = agentTrajectoryHeaders(model.baseUrl, modelCall, attempt, {
          effort: String(options?.reasoning ?? (model.reasoning ? "enabled" : "disabled")),
        });
        try {
          const response = await fetchWithProxy(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(options?.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
              ...(model.headers ?? {}),
              ...(options?.headers ?? {}),
              ...traceHeaders,
            },
            body: JSON.stringify(transformed ?? configured),
            signal: deadline.signal,
          }, proxyUrl);
          const raw = await response.text();
          if (!response.ok) throw new Error(`${response.status} ${readOpenAIError(raw)}`.trim());
          return JSON.parse(raw) as Record<string, any>;
        } catch (error) {
          throw deadline.timeoutError() ?? error;
        } finally {
          deadline.stop();
        }
      }, { signal: options?.signal });
      populateAssistantMessage(output, json);
      emitCompletedMessage(eventStream, output);
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      eventStream.push({ type: "error", reason: output.stopReason, error: output });
      eventStream.end();
    }
  })();
  return observeModelStream(model, modelCall?.modelCallId, eventStream, emptyRetries > 0 && !options?.signal?.aborted ? () => guardedPiNonStreaming(model, context, options, proxyUrl, emptyRetries - 1) : undefined,
    (options as SimpleStreamOptions & { toolChoice?: unknown } | undefined)?.toolChoice);
}

const discardedToolOutputs = new WeakSet<AssistantMessage>();

export function markDiscardedToolOutput(message: AssistantMessage): void {
  discardedToolOutputs.add(message);
}

function missingRequiredTool(message: AssistantMessage, choice: unknown): boolean {
  const selected = choice && typeof choice === "object"
    ? choice as { type?: string; name?: string; function?: { name?: string } } : undefined;
  const name = selected?.type === "function" ? selected.function?.name ?? selected.name : undefined;
  if (choice !== "required" && !name) return false;
  return !message.content.some(part => part.type === "toolCall" && (!name || part.name === name));
}

export function observeModelStream(model: Model<Api>, modelCallId: string | undefined, source: AssistantMessageEventStream, retry?: () => AssistantMessageEventStream, toolChoice?: unknown, retryOnInactivity = false): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  let started = false;
  const forward = (event: Parameters<typeof output.push>[0]) => {
    // Pi appends a transcript message on start. Transport attempts belong to
    // one logical response; a retry replaces its provisional partial message.
    if (event.type === "start") { if (started) return; started = true; }
    output.push(event);
  };
  void (async () => {
    let lastPartial: AssistantMessage | undefined;
    try {
      let pendingStart: Parameters<typeof output.push>[0] | undefined;
      for await (const event of source) {
        if ("partial" in event) lastPartial = event.partial;
        if (event.type === "start") { pendingStart = event; continue; }
        if (retryOnInactivity && event.type === "error" && retry && event.error.stopReason !== "aborted"
          && (event.error as AssistantMessage & {errorCode?: string}).errorCode === "MODEL_STREAM_INACTIVITY") {
          recordExecutionEvidence("model-call-completed", {modelCallId,status:"error",response:event.error,
            ...(lastPartial?.content.length?{partialOutput:lastPartial}:{})});
          recordExecutionEvidence("model-call-retry", {modelCallId,reason:"MODEL_STREAM_INACTIVITY"});
          for await (const retried of retry()) forward(retried);
          return;
        }
        if (event.type === "done"
          && !discardedToolOutputs.has(event.message)
          && !lastPartial?.content.some(part => part.type === "toolCall")
          && !event.message.content.some(part => part.type === "toolCall" || (part.type === "text" && part.text.trim().length > 0))) {
          const outputLimitReached = event.message.stopReason === "length";
          recordExecutionEvidence("model-call-completed", { modelCallId, status: outputLimitReached ? "output_limit" : "empty", response: event.message });
          if (retry && !outputLimitReached) {
            recordExecutionEvidence("model-call-retry", { modelCallId, reason: "MODEL_EMPTY_RESPONSE" });
            for await (const retried of retry()) forward(retried);
          } else {
            const failure = { ...event.message, stopReason: "error" as const,
              errorCode: outputLimitReached ? "MODEL_OUTPUT_LIMIT" : "MODEL_EMPTY_RESPONSE",
              errorMessage: outputLimitReached
                ? "The provider exhausted the requested output token limit without producing a usable response; no retry was attempted."
                : "The provider completed without text or a tool call; automatic retry was suppressed to avoid a duplicate paid generation." };
            output.push({ type: "error", reason: "error", error: failure });
          }
          return;
        }
        if (event.type === "done" && event.message.stopReason !== "length"
          && !discardedToolOutputs.has(event.message) && missingRequiredTool(event.message, toolChoice)) {
          recordExecutionEvidence("model-call-completed", { modelCallId, status: "invalid_tool_choice", response: event.message });
          if (retry) {
            recordExecutionEvidence("model-call-retry", { modelCallId, reason: "MODEL_REQUIRED_TOOL_MISSING" });
            for await (const retried of retry()) forward(retried);
          } else {
            const failure = { ...event.message, stopReason: "error" as const, errorCode: "MODEL_REQUIRED_TOOL_MISSING",
              errorMessage: "The provider completed without the required tool call; the transport retry budget is exhausted." };
            output.push({ type: "error", reason: "error", error: failure });
          }
          return;
        }
        if (pendingStart) { forward(pendingStart); pendingStart = undefined; }
        if (event.type === "done" || event.type === "error") recordExecutionEvidence("model-call-completed", {
          modelCallId, status: event.type, response: event.type === "done" ? event.message : event.error,
          ...((event.type === "error" || (event.type === "done" && event.message.stopReason === "length")) && lastPartial?.content.length ? { partialOutput: lastPartial } : {}),
        });
        forward(event);
      }
    } catch (error) {
      const message = emptyAssistantMessage(model);
      message.stopReason = "error"; message.errorMessage = String(error);
      recordExecutionEvidence("model-call-completed", { modelCallId, status: "error", response: message, ...(lastPartial?.content.length ? { partialOutput: lastPartial } : {}) });
      output.push({ type: "error", reason: "error", error: message });
    } finally { output.end(); }
  })();
  return output;
}

export function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function explicitDeepSeekThinkingMode(payload: unknown, model: Model<Api>): unknown {
  if (!model.id.toLowerCase().startsWith("deepseek-v4-") || !payload || typeof payload !== "object") return payload;
  // Leave V4's reasoning policy to the model/provider unless InkOS explicitly
  // enabled reasoning. Sending `disabled` by default breaks endpoints where
  // reasoning is mandatory.
  if (!model.reasoning) return payload;
  const body = { ...payload, thinking: { type: "enabled" } } as Record<string, unknown>;
  if (body.max_completion_tokens !== undefined) {
    body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }
  return body;
}

/**
 * pi-ai currently serializes an omitted reasoning preference as an explicit
 * `none`/`disabled` setting for some OpenAI-compatible providers. That is not
 * equivalent to an automatic policy: some model endpoints require reasoning.
 * Preserve an explicit caller choice; use low effort for models marked as
 * reasoning-capable, and otherwise remove the implicit disable value.
 */
function applyDefaultReasoningPolicy(
  payload: unknown,
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): unknown {
  if (options?.reasoning !== undefined) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const body = { ...(payload as Record<string, unknown>) };
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.toLowerCase() === "none") {
    if (model.reasoning) body.reasoning_effort = "low";
    else delete body.reasoning_effort;
  }
  if (body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
    const reasoning = { ...(body.reasoning as Record<string, unknown>) };
    if (typeof reasoning.effort === "string" && reasoning.effort.toLowerCase() === "none") {
      if (model.reasoning) {
        reasoning.effort = "low";
        body.reasoning = reasoning;
      } else {
        delete reasoning.effort;
        if (Object.keys(reasoning).length === 0) delete body.reasoning;
        else body.reasoning = reasoning;
      }
    }
  }
  if (body.thinking && typeof body.thinking === "object" && !Array.isArray(body.thinking)) {
    const thinking = { ...(body.thinking as Record<string, unknown>) };
    if (typeof thinking.type === "string" && thinking.type.toLowerCase() === "disabled") {
      if (model.reasoning) {
        thinking.type = "enabled";
        body.thinking = thinking;
      } else {
        delete thinking.type;
        if (Object.keys(thinking).length === 0) delete body.thinking;
        else body.thinking = thinking;
      }
    }
  }
  if (body.enable_thinking === false) {
    if (model.reasoning) body.enable_thinking = true;
    else delete body.enable_thinking;
  }
  return body;
}

export function toOpenAIChatMessages(context: Context): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (context.systemPrompt?.trim()) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: openAIUserContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const reasoning = message.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("");
      const toolCalls = message.content
        .filter((part): part is ToolCall => part.type === "toolCall")
        .map((part) => ({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.arguments) },
        }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    messages.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.toolName,
      content: text,
    });
  }
  return messages;
}

function openAIUserContent(content: Context["messages"][number] extends infer _T ? any : never): unknown {
  if (typeof content === "string") return content;
  // Text-only messages have one canonical wire representation. Some compatible
  // tool-history adapters otherwise lose the text in a content-parts array.
  if(content.every((part:{type:string})=>part.type==='text'))return content.map((part:{text:string})=>part.text).join('\n');
  return content.map((part: { type: string; text?: string; data?: string; mimeType?: string }) => (
    part.type === "image"
      ? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
      : { type: "text", text: part.text ?? "" }
  ));
}

export function populateAssistantMessage(output: AssistantMessage, json: Record<string, any>): void {
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const message = choice?.message ?? {};
  const finishReason = String(choice?.finish_reason ?? "stop");
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  if (reasoning) output.content.push({ type: "thinking", thinking: reasoning });
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part: any) => part?.text ?? "").join("")
      : "";
  if (text) output.content.push({ type: "text", text });
  // A syntactically valid tool argument can still be an incomplete result.
  // Never execute a tool from a response the upstream marked as truncated.
  if (finishReason === "length" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    discardedToolOutputs.add(output);
    recordExecutionEvidence("model-tool-output-discarded", {responseId:json.id,reason:finishReason,toolCount:message.tool_calls.length});
  }
  for (const item of finishReason !== "length" && Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!item?.function?.name) continue;
    output.content.push({
      type: "toolCall",
      id: typeof item.id === "string" && item.id ? item.id : `call_${randomUUID()}`,
      name: item.function.name,
      arguments: parseToolArguments(item.function.arguments),
    });
  }
  output.responseId = typeof json.id === "string" ? json.id : undefined;
  const usage = json.usage ?? {};
  output.usage = {
    ...output.usage,
    input: Number(usage.prompt_tokens ?? 0),
    output: Number(usage.completion_tokens ?? 0),
    cacheRead: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
  };
  output.stopReason = output.content.some((part) => part.type === "toolCall")
    ? "toolUse"
    : finishReason === "length"
      ? "length"
      : "stop";
}

export function emitCompletedMessage(stream: AssistantMessageEventStream, output: AssistantMessage): void {
  const partial = { ...output, content: [] } as AssistantMessage;
  stream.push({ type: "start", partial });
  for (const [contentIndex, part] of output.content.entries()) {
    partial.content.push(part);
    if (part.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial });
      stream.push({ type: "text_delta", contentIndex, delta: part.text, partial });
      stream.push({ type: "text_end", contentIndex, content: part.text, partial });
    } else if (part.type === "thinking") {
      stream.push({ type: "thinking_start", contentIndex, partial });
      stream.push({ type: "thinking_delta", contentIndex, delta: part.thinking, partial });
      stream.push({ type: "thinking_end", contentIndex, content: part.thinking, partial });
    } else {
      stream.push({ type: "toolcall_start", contentIndex, partial });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(part.arguments), partial });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial });
    }
  }
  stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
  stream.end();
}

export function parseToolArguments(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

export function readOpenAIError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // Fall through to the bounded raw response.
  }
  return raw;
}
