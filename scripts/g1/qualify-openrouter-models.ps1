[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RepoRoot,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$WorkspaceRoot,

    [string]$ExpectedSourceRef = "origin/custom/main",

    [ValidateRange(30, 300)]
    [int]$TimeoutSeconds = 90,

    [ValidateRange(256, 2048)]
    [int]$MaxTokens = 2048
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-GitText {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = & git -C $script:ResolvedRepo @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: git $($Arguments -join ' ')"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

$ResolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$ResolvedWorkspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path

if (-not (Test-Path -LiteralPath (Join-Path $ResolvedWorkspace "inkos.json") -PathType Leaf)) {
    throw "Workspace inkos.json not found: $ResolvedWorkspace"
}

$branch = Invoke-GitText -Arguments @("branch", "--show-current")
$head = Invoke-GitText -Arguments @("rev-parse", "HEAD")
$sourceHead = Invoke-GitText -Arguments @("rev-parse", "--verify", $ExpectedSourceRef)

$provenanceScriptPath = Join-Path $PSScriptRoot "core-build-provenance.ps1"
if (-not (Test-Path -LiteralPath $provenanceScriptPath -PathType Leaf)) {
    throw "Core build provenance script is missing: $provenanceScriptPath"
}

$expectedProvenanceBlob = "87c79a4e740ace32cf47299a4348c833368191af"
$actualProvenanceBlob = Invoke-GitText -Arguments @("hash-object", "--", $provenanceScriptPath)
if ($actualProvenanceBlob -ne $expectedProvenanceBlob) {
    throw "Core build provenance script integrity check failed: $actualProvenanceBlob"
}

$buildEvidence = & $provenanceScriptPath -Mode Verify -RepoRoot $ResolvedRepo -ExpectedSourceRef $ExpectedSourceRef
if (-not $buildEvidence -or $buildEvidence.status -ne "BUILD_PROVENANCE_VERIFIED") {
    throw "Core build provenance verification did not return a verified result."
}
$distHashes = @($buildEvidence.distFiles)

$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0) {
    throw "Node.js is not available."
}

$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$scriptCommit = if ($env:INKOS_G1_SCRIPT_COMMIT) { $env:INKOS_G1_SCRIPT_COMMIT } else { "not-supplied" }

Write-Host "=== LOCAL SOURCE PRECHECK ==="
[pscustomobject]@{
    branch = $branch
    localHead = $head
    comparedSourceRef = $ExpectedSourceRef
    comparedSourceHead = $sourceHead
    sourceAndBuildInputsMatch = $true
    buildProvenanceVerified = $true
    buildSourceCommit = $buildEvidence.sourceCommit
    expectedSourceCommit = $buildEvidence.expectedSourceCommit
    buildScriptSha256 = $buildEvidence.buildScriptSha256
    node = $nodeVersion
    scriptCommit = $scriptCommit
    scriptSha256 = $scriptHash
    workspaceConfigPresent = $true
    distFiles = $distHashes
} | ConvertTo-Json -Depth 5

$previousGuardExists = Test-Path Env:INKOS_OPENROUTER_FREE_ONLY
$previousGuardValue = if ($previousGuardExists) { $env:INKOS_OPENROUTER_FREE_ONLY } else { $null }
$previousDiagnosticEnv = @{}
foreach ($name in @("INKOS_G1_REPO_ROOT", "INKOS_G1_WORKSPACE_ROOT", "INKOS_G1_MAX_TOKENS", "INKOS_G1_TIMEOUT_SECONDS", "INKOS_G1_SCRIPT_COMMIT", "INKOS_G1_SCRIPT_SHA256")) {
    $previousDiagnosticEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$env:INKOS_G1_REPO_ROOT = $ResolvedRepo
$env:INKOS_G1_WORKSPACE_ROOT = $ResolvedWorkspace
$env:INKOS_G1_MAX_TOKENS = [string]$MaxTokens
$env:INKOS_G1_TIMEOUT_SECONDS = [string]$TimeoutSeconds
$env:INKOS_G1_SCRIPT_COMMIT = $scriptCommit
$env:INKOS_G1_SCRIPT_SHA256 = $scriptHash

Push-Location $ResolvedRepo
try {
    # The guard is disabled only in this diagnostic PowerShell process and its Node child.
    $env:INKOS_OPENROUTER_FREE_ONLY = "0"

    $nodeSource = @'
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.INKOS_OPENROUTER_FREE_ONLY = "0";

const repoRoot = resolve(process.env.INKOS_G1_REPO_ROOT ?? process.cwd());
const workspaceRoot = resolve(process.env.INKOS_G1_WORKSPACE_ROOT ?? "");
const maxTokens = Number(process.env.INKOS_G1_MAX_TOKENS ?? 2048);
const timeoutMs = Number(process.env.INKOS_G1_TIMEOUT_SECONDS ?? 90) * 1000;
const scriptCommit = process.env.INKOS_G1_SCRIPT_COMMIT ?? "not-supplied";
const scriptSha256 = process.env.INKOS_G1_SCRIPT_SHA256 ?? "not-supplied";

const models = [
  { family: "Z.ai", id: "z-ai/glm-5.3-flash" },
  { family: "DeepSeek", id: "deepseek/deepseek-v4.1-flash" },
  { family: "Alibaba Qwen", id: "qwen/qwen3.6-35b-a3b" },
];

const expectedRoles = [
  { tier: "major", name: "Anna" },
  { tier: "minor", name: "Pavel" },
  { tier: "minor", name: "Irina" },
];

// Pi's OpenAI SDK uses two internal retries per prepared payload. These
// attempts do not emit model-request-prepared evidence again.
const sdkAttemptsPerPreparedRequest = 3;
const maxPreparedRequestsPerModel = 6;
const priceCap = { prompt: 0.15, completion: 0.75 };
const assumedInputTokensPerRequest = 8500;
const authorizedBudgetUsd = 0.20;
const totalRequestCeiling = models.length * maxPreparedRequestsPerModel * sdkAttemptsPerPreparedRequest;
const estimatedWorstCaseUsd =
  (totalRequestCeiling * assumedInputTokensPerRequest * priceCap.prompt
    + totalRequestCeiling * maxTokens * priceCap.completion) / 1_000_000;

let apiKey = "";

function safeText(value, limit = 1200) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  } catch {
    text = String(value);
  }

  if (apiKey) text = text.split(apiKey).join("[REDACTED]");
  return text
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, limit);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeError(error, depth = 0) {
  if (!error) return null;
  if (depth > 3) return "[CAUSE_DEPTH_LIMIT]";

  const summary = {
    name: error.name ?? null,
    code: error.code ?? null,
    message: safeText(error.message),
    attempts: error.attempts ?? null,
    resultTool: error.resultTool ?? null,
    stopReason: error.stopReason ?? null,
    status: error.status ?? error.statusCode ?? null,
  };

  if (error.cause) summary.cause = summarizeError(error.cause, depth + 1);

  if (error.lastToolError) {
    const parts = Array.isArray(error.lastToolError.content)
      ? error.lastToolError.content.map(part => part?.text ?? "").join("\n")
      : error.lastToolError.message ?? "";
    summary.lastToolError = {
      isError: error.lastToolError.isError ?? null,
      content: safeText(parts),
    };
  }

  if (error.lastAssistantText) {
    summary.lastAssistantText = safeText(error.lastAssistantText);
  }

  return summary;
}

function summarizeEvidence(type, payload) {
  if (type === "model-call-started") {
    return {
      type,
      model: payload.model ?? null,
      maxTokens: payload.maxTokens ?? null,
      agentRole: payload.trace?.agentRole ?? null,
    };
  }

  if (type === "model-request-prepared") {
    const parameters = payload.parameters ?? {};
    return {
      type,
      model: payload.model ?? null,
      api: payload.api ?? null,
      parameters: {
        max_tokens: parameters.max_tokens ?? null,
        max_output_tokens: parameters.max_output_tokens ?? null,
        max_completion_tokens: parameters.max_completion_tokens ?? null,
        tool_choice: parameters.tool_choice ?? null,
        thinking: parameters.thinking ?? null,
      },
    };
  }

  if (type === "model-call-completed") {
    const response = payload.response ?? {};
    const usage = response.usage ?? {};
    const cost = usage.cost ?? {};
    const content = Array.isArray(response.content) ? response.content : [];

    return {
      type,
      status: payload.status ?? null,
      model: response.model ?? null,
      api: response.api ?? null,
      piProvider: response.provider ?? null,
      stopReason: response.stopReason ?? null,
      errorCode: response.errorCode ?? null,
      errorMessage: response.errorMessage ? safeText(response.errorMessage) : null,
      contentTypes: content.map(part => part?.type ?? "unknown"),
      toolNames: content
        .filter(part => part?.type === "toolCall")
        .map(part => part.name ?? "unknown"),
      usage: {
        input: finite(usage.input),
        output: finite(usage.output),
        totalTokens: finite(usage.totalTokens),
        costTotal: finite(cost.total),
      },
    };
  }

  if (type === "model-call-retry") {
    return { type, reason: payload.reason ?? null };
  }

  if (type === "worker-result-invalid") {
    return {
      type,
      code: payload.code ?? null,
      resultTool: payload.resultTool ?? null,
      issues: Array.isArray(payload.issues)
        ? payload.issues.map(issue => ({
            path: issue.path ?? null,
            message: safeText(issue.message ?? ""),
          }))
        : [],
    };
  }

  return null;
}

async function importCore(relativePath) {
  return import(pathToFileURL(join(repoRoot, relativePath)).href);
}

async function main() {
  if (!workspaceRoot || !repoRoot) throw new Error("Repository/workspace root is missing");
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 2048) throw new Error("maxTokens must be between 256 and 2048 for the approved budget");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000) throw new Error("Invalid timeout");
  if (estimatedWorstCaseUsd > authorizedBudgetUsd) {
    throw new Error("Estimated qualification ceiling exceeds the approved $0.20 budget");
  }

  const core = await importCore("packages/core/dist/index.js");
  const workerModule = await importCore("packages/core/dist/agent/worker-agent.js");
  const architectModule = await importCore("packages/core/dist/agents/architect-tool.js");
  const evidenceModule = await importCore("packages/core/dist/harness/execution-evidence.js");
  const providerModule = await importCore("packages/core/dist/llm/provider.js");

  const { loadProjectConfig, createLLMClient, PipelineRunner } = core;
  const { runWorkerAgentTool } = workerModule;
  const { FoundationCastIndexToolSchema } = architectModule;
  const { withExecutionEvidence } = evidenceModule;
  const { estimatePiContextTokens } = providerModule;

  if (
    typeof loadProjectConfig !== "function"
    || typeof createLLMClient !== "function"
    || typeof PipelineRunner !== "function"
    || typeof runWorkerAgentTool !== "function"
    || typeof withExecutionEvidence !== "function"
    || typeof estimatePiContextTokens !== "function"
    || !FoundationCastIndexToolSchema
  ) {
    throw new Error("Required Core exports are missing from the local dist");
  }

  const projectConfig = await loadProjectConfig(workspaceRoot, {
    consumer: "studio",
  });

  if (!projectConfig.llm) throw new Error("Studio LLM configuration is missing");

  const originalLLM = projectConfig.llm;
  if (originalLLM.service !== "openrouter") {
    throw new Error("Expected Studio service=openrouter");
  }
  if (originalLLM.apiFormat !== "responses") {
    throw new Error("Expected Studio apiFormat=responses");
  }
  if (new URL(originalLLM.baseUrl).origin !== "https://openrouter.ai") {
    throw new Error("Expected the official OpenRouter endpoint");
  }

  apiKey = originalLLM.apiKey ?? "";
  if (!apiKey) throw new Error("OpenRouter API key is missing");

  const extra = { ...(originalLLM.extra ?? {}) };
  const removedTopLevelKeys = [];
  for (const key of ["models", "route", "plugins"]) {
    if (key in extra) {
      delete extra[key];
      removedTopLevelKeys.push(key);
    }
  }

  const inheritedProvider =
    extra.provider && typeof extra.provider === "object" && !Array.isArray(extra.provider)
      ? { ...extra.provider }
      : {};

  const removedProviderRoutingKeys = [];
  for (const key of ["order", "only", "ignore", "sort", "quantizations"]) {
    if (key in inheritedProvider) {
      delete inheritedProvider[key];
      removedProviderRoutingKeys.push(key);
    }
  }

  const provider = {
    ...inheritedProvider,
    allow_fallbacks: true,
    require_parameters: true,
    max_price: priceCap,
  };

  extra.provider = provider;

  const testLLMConfig = {
    ...originalLLM,
    extra,
  };

  const baseClient = createLLMClient(testLLMConfig);
  const basePiModel = baseClient._piModel;

  if (!basePiModel || basePiModel.api !== "openai-responses") {
    throw new Error("Base Core client did not resolve openai-responses");
  }

  const basePrecheck = {
    service: baseClient.service,
    apiFormat: baseClient.apiFormat,
    piApi: basePiModel.api,
    endpointOrigin: new URL(basePiModel.baseUrl).origin,
    apiKeyPresent: Boolean(baseClient._apiKey),
    freeOnlyGuard: process.env.INKOS_OPENROUTER_FREE_ONLY ?? null,
    providerPolicy: {
      allow_fallbacks: provider.allow_fallbacks,
      require_parameters: provider.require_parameters,
      max_price: provider.max_price,
      inheritedPrivacyKeys: Object.keys(provider).filter(
        key => !["allow_fallbacks", "require_parameters", "max_price"].includes(key)
      ),
    },
    removedTopLevelKeys,
    removedProviderRoutingKeys,
  };

  console.log("\n=== BASE PRECHECK ===");
  console.log(JSON.stringify(basePrecheck, null, 2));

  if (process.env.INKOS_OPENROUTER_FREE_ONLY === "1") {
    throw new Error("Free-only guard is still enabled in the Node process");
  }

  const tool = {
    name: "submit_foundation_cast_index",
    label: "Identify opening cast",
    description: "Submit the names and tiers of the opening cast.",
    parameters: FoundationCastIndexToolSchema,
  };

  const messages = [
    {
      role: "system",
      content:
        "Submit the cast index using the required tool. "
        + "Return exactly the three named characters.",
    },
    {
      role: "user",
      content:
        "Opening cast: Anna (major), Pavel (minor), Irina (minor). "
        + "Preserve all three names and tiers in this order. Do not add characters.",
    },
  ];

  const results = [];

  for (const spec of models) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const events = [];
    let usage = null;
    let preparedRequests = 0;
    let controller = null;
    let timeoutHandle = null;
    let item;

    console.log("\n================================================");
    console.log("MODEL: " + spec.id + " (" + spec.family + ")");
    console.log("================================================");

    try {
      const runner = new PipelineRunner({
        client: baseClient,
        model: testLLMConfig.model,
        projectRoot: workspaceRoot,
        modelOverrides: {
          ...(projectConfig.modelOverrides ?? {}),
          architect: spec.id,
        },
      });

      const ctx = runner.createAgentContext("architect");
      const piModel = ctx.client._piModel;
      const effectiveProvider = ctx.client.defaults.extra.provider ?? {};

      const precheck = {
        family: spec.family,
        requestedModel: spec.id,
        resolvedModel: ctx.model,
        piModelId: piModel?.id ?? null,
        piModelName: piModel?.name ?? null,
        piApi: piModel?.api ?? null,
        piProvider: piModel?.provider ?? null,
        service: ctx.client.service,
        apiFormat: ctx.client.apiFormat,
        endpointOrigin: piModel?.baseUrl ? new URL(piModel.baseUrl).origin : null,
        apiKeyPresent: Boolean(ctx.client._apiKey),
        freeOnlyGuard: process.env.INKOS_OPENROUTER_FREE_ONLY ?? null,
        providerPolicy: {
          allow_fallbacks: effectiveProvider.allow_fallbacks ?? null,
          require_parameters: effectiveProvider.require_parameters ?? null,
          max_price: effectiveProvider.max_price ?? null,
        },
      };

      console.log("PRECHECK: " + JSON.stringify(precheck));

      if (
        ctx.model !== spec.id
        || (piModel?.id !== spec.id && piModel?.name !== spec.id)
        || piModel?.api !== "openai-responses"
        || ctx.client.service !== "openrouter"
        || ctx.client.apiFormat !== "responses"
        || precheck.endpointOrigin !== "https://openrouter.ai"
        || !ctx.client._apiKey
        || effectiveProvider.allow_fallbacks !== true
        || effectiveProvider.require_parameters !== true
        || effectiveProvider.max_price?.prompt !== priceCap.prompt
        || effectiveProvider.max_price?.completion !== priceCap.completion
        || process.env.INKOS_OPENROUTER_FREE_ONLY === "1"
      ) {
        throw Object.assign(new Error("Resolved model override precheck failed"), {
          code: "MODEL_PRECHECK_FAILED",
        });
      }

      controller = new AbortController();
      timeoutHandle = setTimeout(() => {
        controller.abort(new Error("Model diagnostic timed out"));
      }, timeoutMs);

      const sink = (type, payload) => {
        if (type === "model-call-started"
          && estimatePiContextTokens(payload.context) > assumedInputTokensPerRequest) {
          controller.abort(new Error("Input exceeds the budget estimate assumption"));
          throw new Error("Input exceeds the budget estimate assumption");
        }
        if (type === "model-request-prepared") {
          preparedRequests += 1;
          if (preparedRequests > maxPreparedRequestsPerModel) {
            controller.abort(new Error("Prepared-request safety ceiling exceeded"));
            throw new Error("Prepared-request safety ceiling exceeded");
          }
        }

        const event = summarizeEvidence(type, payload);
        if (event) events.push(event);
      };

      const result = await withExecutionEvidence(
        sink,
        () => runWorkerAgentTool(
          ctx.client,
          ctx.model,
          messages,
          tool,
          {
            temperature: 0.8,
            maxTokens,
            signal: controller.signal,
            onUsage: value => { usage = value; },
          },
        ),
      );

      const actualRoles = Array.isArray(result?.roles)
        ? result.roles.map(role => ({ tier: role.tier, name: role.name }))
        : [];

      const passed = JSON.stringify(actualRoles) === JSON.stringify(expectedRoles);

      item = {
        family: spec.family,
        model: spec.id,
        status: passed ? "PASS" : "CONTRACT_MISMATCH",
        expectedRoles,
        actualRoles,
      };
    } catch (error) {
      item = {
        family: spec.family,
        model: spec.id,
        status: controller?.signal.aborted ? "ABORTED_OR_LIMIT_REACHED" : "FAIL",
        error: summarizeError(error),
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    item.startedAt = startedAt;
    item.finishedAt = new Date().toISOString();
    item.elapsedMs = Date.now() - startedMs;
    item.preparedRequests = preparedRequests;
    item.maxPreparedRequests = maxPreparedRequestsPerModel;
    item.usage = usage;
    item.evidence = events;

    console.log("\n=== MODEL RESULT ===");
    console.log(JSON.stringify(item, null, 2));
    results.push(item);

    await new Promise(resolveDelay => setTimeout(resolveDelay, 1200));
  }

  console.log("\n=== QUALIFICATION SUMMARY ===");
  console.log(JSON.stringify({
    scriptCommit,
    scriptSha256,
    service: "openrouter",
    apiFormat: "responses",
    piApi: "openai-responses",
    freeOnlyGuard: process.env.INKOS_OPENROUTER_FREE_ONLY ?? null,
    budget: {
      authorizedUsd: authorizedBudgetUsd,
      maxPreparedRequestsPerModel,
      sdkAttemptsPerPreparedRequest,
      maxTokensPerRequest: maxTokens,
      maxPricePerMillion: priceCap,
      assumedInputTokensPerRequest: assumedInputTokensPerRequest,
      estimatedWorstCaseUsdAtAssumption: Number(estimatedWorstCaseUsd.toFixed(6)),
      note: "Estimate only, not an account-level hard billing cap. Verify actual charges in OpenRouter Activity.",
    },
    results: results.map(item => ({
      family: item.family,
      model: item.model,
      status: item.status,
      preparedRequests: item.preparedRequests,
      elapsedMs: item.elapsedMs,
      usage: item.usage,
    })),
  }, null, 2));

  console.log("\nNo project config, modelOverrides, Work, or manuscript files were written.");
  console.log("OpenRouter Activity is required to confirm the upstream provider and actual billed cost.");

  if (results.some(item => item.status !== "PASS")) process.exitCode = 1;
}

main().catch(error => {
  console.error("\n=== FATAL PRECHECK FAILURE ===");
  console.error(JSON.stringify(summarizeError(error), null, 2));
  process.exitCode = 1;
});
'@

    $nodeSource | & node --input-type=module -
    $nodeExitCode = $LASTEXITCODE
    if ($nodeExitCode -ne 0) {
        throw "Model qualification process exited with code $nodeExitCode."
    }
}
finally {
    Pop-Location

    if ($previousGuardExists) {
        $env:INKOS_OPENROUTER_FREE_ONLY = $previousGuardValue
    }
    else {
        Remove-Item Env:INKOS_OPENROUTER_FREE_ONLY -ErrorAction SilentlyContinue
    }

    foreach ($name in @(
        "INKOS_G1_REPO_ROOT",
        "INKOS_G1_WORKSPACE_ROOT",
        "INKOS_G1_MAX_TOKENS",
        "INKOS_G1_TIMEOUT_SECONDS",
        "INKOS_G1_SCRIPT_COMMIT",
        "INKOS_G1_SCRIPT_SHA256"
    )) {
        [Environment]::SetEnvironmentVariable($name, $previousDiagnosticEnv[$name], "Process")
    }
}
