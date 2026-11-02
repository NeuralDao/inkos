import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { assertWithinContextWindow, createRequestDeadline, createStreamActivityDeadline, estimatePiContextTokens } from "../llm/provider.js";
import { agentTrajectoryHeaders, beginAgentModelCall } from "../llm/agent-trajectory.js";
import { recordExecutionEvidence } from "../harness/execution-evidence.js";
import { MAX_MODEL_OUTPUT_TOKENS } from "../llm/token-limits.js";
import { fetchWithProxy } from "../utils/proxy-fetch.js";
import { emptyAssistantMessage, emitCompletedMessage, explicitDeepSeekThinkingMode, markDiscardedToolOutput, observeModelStream, parseToolArguments, populateAssistantMessage, readOpenAIError, toOpenAIChatMessages } from "./pi-stream.js";

/** A direct HTTP boundary for paid automatic stages: exactly one request. */
export function singleAttemptStream(model: Model<Api>, context: Context, options: SimpleStreamOptions,
  proxyUrl: string | undefined, streaming: boolean, onChunk?: (text: string) => void): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const modelCall = beginAgentModelCall();
  let maxTokens = Math.min(options.maxTokens ?? model.maxTokens ?? MAX_MODEL_OUTPUT_TOKENS, model.maxTokens ?? MAX_MODEL_OUTPUT_TOKENS, MAX_MODEL_OUTPUT_TOKENS);
  let anthropicThinking: Record<string, unknown> | undefined;
  let anthropicEffort: Record<string, unknown> | undefined;
  if (model.api === "anthropic-messages" && model.reasoning && !options.reasoning) anthropicThinking = { type: "disabled" };
  if (model.api === "anthropic-messages" && model.reasoning && options.reasoning) {
    const adaptive = /(?:opus|sonnet)-4[.-]6/i.test(model.id);
    if (adaptive) {
      anthropicThinking = { type: "adaptive" };
      const effort = options.reasoning === "minimal" ? "low" : options.reasoning === "xhigh" ? (/opus-4[.-]6/i.test(model.id) ? "max" : "high") : options.reasoning;
      anthropicEffort = { effort };
    } else {
      const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
      const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, ...options.thinkingBudgets };
      let budget = budgets[level] ?? 8192;
      maxTokens = Math.min(maxTokens + budget, model.maxTokens);
      if (maxTokens <= budget) budget = Math.max(0, maxTokens - 1024);
      anthropicThinking = { type: "enabled", budget_tokens: budget };
    }
  }
  assertWithinContextWindow({ piModel: model, model: model.id, estimatedInputTokens: estimatePiContextTokens(context), reservedOutputTokens: maxTokens });
  const deadline = streaming
    ? createStreamActivityDeadline(options.signal, undefined, { firstEventTimeoutMs: 900_000, idleTimeoutMs: 1_000_000 })
    : createRequestDeadline(options.signal);
  const activity = () => { if ("activity" in deadline) deadline.activity(); };
  void (async () => {
    const output = emptyAssistantMessage(model);
    try {
      if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(model.api)) {
        throw Object.assign(new Error(`Single-attempt transport is unavailable for ${model.api}`), { code: "SINGLE_ATTEMPT_TRANSPORT_UNSUPPORTED" });
      }
      const messages = toOpenAIChatMessages(context);
      const tools = context.tools ?? [];
      const anthropic = model.api === "anthropic-messages";
      const responses = model.api === "openai-responses";
      const toolChoice = (options as SimpleStreamOptions & { toolChoice?: unknown }).toolChoice;
      let payload: Record<string, unknown>;
      if (anthropic) {
        if (messages.some(message => message.role === "tool" || message.tool_calls)) throw new Error("Unsupported tool history in single-attempt Anthropic request");
        const anthropicMessages: Array<Record<string, unknown>> = [];
        for (const message of messages.filter(item => item.role !== "system")) {
          const previous = anthropicMessages.at(-1);
          if (previous && previous.role === message.role && typeof previous.content === "string" && typeof message.content === "string") previous.content += `\n\n${message.content}`;
          else anthropicMessages.push({ ...message });
        }
        payload = { model: model.id, system: context.systemPrompt ?? "", messages: anthropicMessages, stream: streaming, max_tokens: maxTokens,
          tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
          ...(tools.length ? { tool_choice: { type: "auto" } } : {}),
          ...(anthropicThinking ? { thinking: anthropicThinking } : {}), ...(anthropicEffort ? { output_config: anthropicEffort } : {}),
          ...(options.temperature === undefined || options.reasoning ? {} : { temperature: options.temperature }) };
      } else if (responses) {
        if (messages.some(message => message.role === "tool" || message.tool_calls)) throw new Error("Unsupported tool history in single-attempt Responses request");
        const input = messages.map(message => message.role === "system" && model.reasoning ? { ...message, role: "developer" } : message);
        payload = { model: model.id, input, stream: streaming, store: false, max_output_tokens: maxTokens,
          tools: tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }), ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(model.reasoning ? { reasoning: { effort: options.reasoning ?? "none" } } : {}) };
      } else {
        const compat = (model as Model<"openai-completions">).compat;
        const nonStandard = /cerebras\.ai|api\.x\.ai|chutes\.ai|deepseek\.com|api\.z\.ai|opencode\.ai/i.test(model.baseUrl) || ["cerebras", "xai", "zai", "opencode"].includes(model.provider);
        const supportsDeveloper = compat?.supportsDeveloperRole ?? !nonStandard;
        const chatMessages = messages.map(message => message.role === "system" && model.reasoning && supportsDeveloper ? { ...message, role: "developer" } : message);
        const maxField = !streaming ? "max_tokens" : compat?.maxTokensField ?? (model.baseUrl.includes("chutes.ai") ? "max_tokens" : "max_completion_tokens");
        const thinkingFormat = compat?.thinkingFormat ?? (model.provider === "zai" || model.baseUrl.includes("api.z.ai") ? "zai" : model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai");
        const effort = options.reasoning ? compat?.reasoningEffortMap?.[options.reasoning] ?? options.reasoning : undefined;
        const thinking = !model.reasoning ? {} : thinkingFormat === "zai" || thinkingFormat === "qwen" ? { enable_thinking: !!effort } :
          thinkingFormat === "qwen-chat-template" ? { chat_template_kwargs: { enable_thinking: !!effort } } :
          thinkingFormat === "openrouter" ? { reasoning: { effort: effort ?? "none" } } : effort && compat?.supportsReasoningEffort !== false ? { reasoning_effort: effort } : {};
        payload = { model: model.id, messages: chatMessages, stream: streaming, [maxField]: maxTokens,
          ...(streaming && compat?.supportsUsageInStreaming !== false ? { stream_options: { include_usage: true } } : {}),
          tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters, ...(compat?.supportsStrictMode === false ? {} : { strict: false }) } })),
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }), ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...thinking };
      }
      payload = explicitDeepSeekThinkingMode(payload, model) as Record<string, unknown>;
      payload = (await options.onPayload?.(payload, model) ?? payload) as Record<string, unknown>;
      const traceHeaders = agentTrajectoryHeaders(model.baseUrl, modelCall, 1, { effort: String(options.reasoning ?? (model.reasoning ? "enabled" : "disabled")) });
      recordExecutionEvidence("model-call-started", { trace: modelCall, model: model.id, context, maxTokens });
      recordExecutionEvidence("model-request-prepared", { modelCallId: modelCall?.modelCallId, model: model.id, api: model.api,
        parameters: Object.fromEntries(Object.entries(payload).filter(([key]) => ["stream", "thinking", "max_tokens", "max_completion_tokens", "max_output_tokens", "tool_choice"].includes(key))) });
      const headers: Record<string, string> = { "Content-Type": "application/json", ...(model.headers ?? {}), ...(options.headers ?? {}), ...traceHeaders };
      if (anthropic) { headers["x-api-key"] = options.apiKey ?? ""; headers["anthropic-version"] ??= "2023-06-01"; }
      else if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
      const endpoint = anthropic ? "messages" : responses ? "responses" : "chat/completions";
      const response = await fetchWithProxy(`${model.baseUrl.replace(/\/$/, "")}/${endpoint}`, {
        method: "POST", headers, body: JSON.stringify(payload), signal: deadline.signal,
      }, proxyUrl);
      activity();
      if (!response.ok) throw new Error(`${response.status} ${readOpenAIError(await response.text())}`.trim());
      let json: Record<string, any>;
      if (streaming) {
        if (!response.body) throw new Error("Streaming response had no body");
        const accumulated = createAccumulator(model.api, onChunk);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          activity(); buffer += decoder.decode(next.value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? "";
          for (const event of events) accumulated.consume(event);
        }
        buffer += decoder.decode();
        if (buffer.trim()) accumulated.consume(buffer);
        json = accumulated.finish();
      } else {
        json = JSON.parse(await response.text()) as Record<string, any>;
      }
      if (model.api === "openai-completions") {
        const finish = json.choices?.[0]?.finish_reason;
        if (!["stop", "tool_calls", "length"].includes(finish)) throw new Error(`Incomplete or rejected chat response: ${String(finish)}`);
        populateAssistantMessage(output, json);
      }
      else populateResponse(output, json, anthropic);
      if (output.stopReason === "length") markDiscardedToolOutput(output);
      emitCompletedMessage(out, output);
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      const timeout = "timeoutError" in deadline ? deadline.timeoutError() : undefined;
      const failure = timeout ?? error;
      output.errorMessage = failure instanceof Error ? failure.message : String(failure);
      (output as AssistantMessage & { errorCode?: string }).errorCode = (failure as { code?: string } | null)?.code;
      out.push({ type: "error", reason: output.stopReason, error: output }); out.end();
    } finally { deadline.stop(); }
  })();
  return observeModelStream(model, modelCall?.modelCallId, out, undefined, (options as SimpleStreamOptions & { toolChoice?: unknown }).toolChoice, false);
}

function populateResponse(output: AssistantMessage, json: Record<string, any>, anthropic: boolean): void {
  if (anthropic ? !["end_turn", "tool_use", "max_tokens"].includes(json.stop_reason) : !["completed", "incomplete"].includes(json.status)) {
    throw new Error(`Incomplete or rejected provider response: ${String(anthropic ? json.stop_reason : json.status)}`);
  }
  if (!anthropic && json.status === "incomplete" && json.incomplete_details?.reason && json.incomplete_details.reason !== "max_output_tokens") {
    throw Object.assign(new Error(`Provider response incomplete: ${String(json.incomplete_details.reason)}`), { code: "MODEL_RESPONSE_INCOMPLETE" });
  }
  const incomplete = anthropic ? json.stop_reason === "max_tokens" : json.status === "incomplete";
  const items = anthropic ? (json.content ?? []) : (json.output ?? []);
  for (const item of items) {
    if (!incomplete && (item.type === "tool_use" || item.type === "function_call")) output.content.push({ type: "toolCall", id: item.call_id ?? item.id, name: item.name, arguments: parseToolArguments(item.input ?? item.arguments) });
    if (item.type === "text") output.content.push({ type: "text", text: item.text ?? "" });
    if (item.type === "message") for (const part of item.content ?? []) if (part.type === "output_text") output.content.push({ type: "text", text: part.text ?? "" });
    if (item.type === "thinking") output.content.push({ type: "thinking", thinking: item.thinking ?? "" });
  }
  const usage = json.usage ?? {};
  output.usage = { ...output.usage, input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0),
    cacheRead: Number(usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? (Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0))) };
  output.responseId = typeof json.id === "string" ? json.id : undefined;
  output.stopReason = incomplete ? "length" : output.content.some(item => item.type === "toolCall") ? "toolUse" : "stop";
}

function createAccumulator(api: string, onChunk?: (text: string) => void) {
  let terminal = false, explicitFinish = false, text = "", reasoning = "", finishReason = "stop";
  let usage: Record<string, any> = {}, response: Record<string, any> | undefined;
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  const blocks = new Map<number, Record<string, any>>();
  return {
    consume(event: string) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) return;
      if (data === "[DONE]") { terminal = true; return; }
      const value = JSON.parse(data) as Record<string, any>;
      if (value.error || value.type === "error" || value.type === "response.failed") throw new Error(readOpenAIError(data) || "Streaming provider error");
      if (api === "openai-completions") {
        if (value.usage) usage = value.usage;
        const choice = value.choices?.[0]; const delta = choice?.delta ?? {};
        if (typeof delta.content === "string") { text += delta.content; onChunk?.(delta.content); }
        const thought = delta.reasoning_content ?? delta.reasoning ?? (Array.isArray(delta.reasoning_details) ? delta.reasoning_details.map((item: { text?: string }) => item.text ?? "").join("") : undefined);
        if (typeof thought === "string") { reasoning += thought; onChunk?.(thought); }
        for (const call of delta.tool_calls ?? []) {
          const index = Number(call.index ?? 0); const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
          current.id = call.id ?? current.id; current.name += call.function?.name ?? ""; current.arguments += call.function?.arguments ?? "";
          onChunk?.(call.function?.arguments ?? ""); tools.set(index, current);
        }
        if (choice?.finish_reason) { finishReason = choice.finish_reason; terminal = true; explicitFinish = true; }
      } else if (api === "openai-responses") {
        if (value.type === "response.output_item.added" || value.type === "response.output_item.done") blocks.set(Number(value.output_index ?? 0), value.item);
        if (value.type === "response.function_call_arguments.delta") {
          const index = Number(value.output_index ?? 0); const item = blocks.get(index) ?? { type: "function_call", arguments: "" };
          item.arguments = String(item.arguments ?? "") + String(value.delta ?? ""); blocks.set(index, item); onChunk?.(String(value.delta ?? ""));
        }
        if (value.type === "response.output_text.delta" || (typeof value.type === "string" && value.type.includes("reasoning") && value.type.endsWith(".delta"))) onChunk?.(String(value.delta ?? ""));
        if (value.type === "response.completed" || value.type === "response.incomplete") { response = value.response; terminal = true; }
      } else {
        if (value.type === "message_start") usage = value.message?.usage ?? {};
        if (value.type === "content_block_start") blocks.set(Number(value.index), { ...value.content_block, partialJson: "" });
        if (value.type === "content_block_delta") {
          const block = blocks.get(Number(value.index)); const delta = value.delta ?? {};
          if (block) {
            if (delta.type === "input_json_delta") block.partialJson += delta.partial_json ?? "";
            if (delta.type === "text_delta") block.text = String(block.text ?? "") + String(delta.text ?? "");
            if (delta.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + String(delta.thinking ?? "");
            onChunk?.(String(delta.partial_json ?? delta.text ?? delta.thinking ?? ""));
          }
        }
        if (value.type === "message_delta") { usage = { ...usage, ...value.usage }; if (value.delta?.stop_reason) { finishReason = value.delta.stop_reason; explicitFinish = true; } }
        if (value.type === "message_stop") terminal = true;
      }
    },
    finish(): Record<string, any> {
      if (!terminal || (api !== "openai-responses" && !explicitFinish)) throw new Error("Provider stream ended before completion");
      if (api === "openai-completions") return { choices: [{ finish_reason: finishReason, message: { content: text, reasoning_content: reasoning,
        tool_calls: [...tools.values()].map(call => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } }], usage };
      if (api === "openai-responses") {
        if (!response) throw new Error("Responses stream ended without a completed response");
        return { ...response, output: response.output ?? [...blocks.values()] };
      }
      return { stop_reason: finishReason, usage, content: [...blocks.values()].map(block => block.type === "tool_use" ? { ...block, input: block.partialJson ? parseToolArguments(block.partialJson) : block.input } : block) };
    },
  };
}
