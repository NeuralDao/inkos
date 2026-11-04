// Per-role structured-transport smoke against the real OpenRouter endpoint.
// Verifies, for every agent role: the configured model resolves, the call
// returns a schema-valid tool result, and the wire payload carries no explicit
// reasoning-disable directive.
//
// Usage: node scripts/hermes-agent-smoke.mjs [--level-role <role>] [--level <lvl>]
process.env.INKOS_OPENROUTER_FREE_ONLY = "0";

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = "C:\\Projects\\inkos-g4-workspace";
const root = process.cwd();
const dist = resolve(root, "packages/core/dist");

const args = process.argv.slice(2);
const levelRoleIndex = args.indexOf("--level-role");
const levelRole = levelRoleIndex >= 0 ? args[levelRoleIndex + 1] : undefined;
const levelIndex = args.indexOf("--level");
const level = levelIndex >= 0 ? args[levelIndex + 1] : undefined;
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const baseUrlOverride = opt("--base-url");
const apiOverride = opt("--api");
const modelOverride = opt("--model");
const streamOff = args.includes("--no-stream");
const serviceOverride = opt("--service");
const noOverrides = args.includes("--no-overrides");

const coreRequire = createRequire(resolve(process.cwd(), "packages/core/package.json"));
const { Type } = coreRequire("@sinclair/typebox");

const ROLES = ["architect", "planner", "composer", "writer", "auditor", "reviser", "state-validator", "actor", "radar"];
const FORBIDDEN = ["reasoning_effort", "reasoning", "thinking", "enable_thinking"];



const [core, loader, worker] = await Promise.all([
  import(pathToFileURL(resolve(dist, "index.js")).href),
  import(pathToFileURL(resolve(dist, "utils/config-loader.js")).href),
  import(pathToFileURL(resolve(dist, "agent/worker-agent.js")).href),
]);

const config = await loader.loadProjectConfig(projectRoot, { consumer: "studio" });
const base = { ...config.llm };
if (baseUrlOverride) base.baseUrl = baseUrlOverride;
if (apiOverride) base.apiFormat = apiOverride;
if (modelOverride) base.model = modelOverride;
if (streamOff) base.stream = false;
if (serviceOverride) base.service = serviceOverride;
if (noOverrides) base.modelOverrides = {};
if (levelRole && level) {
  base.modelOverrides = { ...(base.modelOverrides ?? {}), [levelRole]: { ...(base.modelOverrides?.[levelRole] ?? {}), model: (base.modelOverrides?.[levelRole]?.model ?? base.model), reasoning: level } };
}

const schema = Type.Object({ ok: Type.Boolean(), note: Type.String() });
const messages = [
  { role: "system", content: "Return exactly one structured tool call with ok=true and a short note." },
  { role: "user", content: "Confirm the structured transport works. Keep the note under ten words." },
];

const payloads = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  try {
    if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
  } catch { /* ignore non-JSON bodies */ }
  return realFetch(url, init);
};

const roleOverrides = noOverrides ? {} : { ...(config.modelOverrides ?? base.modelOverrides ?? {}) };
if (levelRole && level) {
  const current = roleOverrides[levelRole];
  const model = (typeof current === "string" ? current : current?.model) ?? base.model;
  roleOverrides[levelRole] = { ...(typeof current === "object" ? current : {}), model, reasoning: level };
}
const results = [];
for (const role of ROLES) {
  const entry = { role };
  try {
    const client = core.createLLMClient(base);
    const runner = new core.PipelineRunner({ client, model: base.model, projectRoot, modelOverrides: roleOverrides });
    const ctx = runner.createAgentContext(role);
    entry.model = ctx.model;
    entry.reasoningLevel = ctx.client.defaults?.reasoningLevel ?? null;
    entry.activation = ctx.client._piModel?.reasoning ?? null;
    payloads.length = 0;
    let usage;
    const result = await worker.runWorkerAgentTool(ctx.client, ctx.model, messages, {
      name: "submit_smoke", label: "Submit smoke", description: "Submit a smoke acknowledgement.", parameters: schema,
    }, { temperature: 0, maxTokens: 256, signal: AbortSignal.timeout(120_000), onUsage: value => { usage = value; } });
    entry.result = result?.ok === true ? "PASS" : "FAIL";
    entry.usage = usage ?? null;
    const bodies = payloads.filter(body => body && typeof body === "object");
    entry.requests = bodies.length;
    entry.wireReasoning = bodies.map(body => {
      const found = {};
      for (const key of FORBIDDEN) if (key in body) found[key] = body[key];
      return found;
    });
    if (entry.result !== "PASS") entry.wireBody = bodies.map(body => ({ tool_choice: body.tool_choice, tools: body.tools, reasoning: body.reasoning, reasoning_effort: body.reasoning_effort }));
    entry.disableSent = bodies.some(body =>
      body.reasoning_effort === "none" || body.enable_thinking === false
      || (body.reasoning && (body.reasoning.enabled === false || body.reasoning.effort === "none"))
      || (body.thinking && body.thinking.type === "disabled"));
  } catch (error) {
    entry.result = "FAIL";
    entry.code = error?.code ?? null;
    entry.message = String(error?.message ?? error).slice(0, 300);
    entry.stopReason = error?.stopReason ?? null;
  }
  results.push(entry);
  console.log(JSON.stringify(entry));
}

globalThis.fetch = realFetch;
console.log(JSON.stringify({ summary: true, total: results.length, passed: results.filter(r => r.result === "PASS").length,
  disablesSent: results.filter(r => r.disableSent).length }, null, 2));
if (results.some(r => r.result !== "PASS" || r.disableSent)) process.exitCode = 1;
