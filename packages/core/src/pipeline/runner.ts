import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {readPinnedParentCanon} from "../harness/parent-canon.js";
import {renderChapterDocument,chapterDocumentBody} from '../utils/chapter-document.js';
import {changedSourceRegion} from '../utils/source-text.js';
import {createBuiltInWorkProfileRegistry} from "../harness/builtin-profiles.js";
import type { LLMClient, OnStreamProgress } from "../llm/provider.js";
import { clientWithModel } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";
import { BookConfigSchema, type BookConfig, type FanficMode } from "../models/book.js";
import { StateManifestSchema, CurrentStateStateSchema, HooksStateSchema, ChapterSummariesStateSchema, RuntimeStateDeltaSchema } from "../models/runtime-state.js";
import { resolveNarrativeLanguage, type NarrativeLanguage } from "../utils/book-language.js";
import { AutoRevisionOutcomeSchema, type AutoRevisionOutcome, type ChapterMeta } from "../models/chapter.js";
import type { NotifyChannel, LLMConfig, AgentLLMOverride } from "../models/project.js";
import { ArchitectAgent, type ArchitectOutput } from "../agents/architect.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { ComposerAgent, type ComposeChapterOutput } from "../agents/composer.js";
import { WriterAgent, type WriteChapterDraftOutput, type WriteChapterInput, type WriteChapterOutput } from "../agents/writer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReviserAgent, DEFAULT_REVISE_MODE, type ReviseMode } from "../agents/reviser.js";
import { StateValidatorAgent, type ValidationResult } from "../agents/state-validator.js";
import { RadarAgent } from "../agents/radar.js";
import type { RadarSource } from "../agents/radar-source.js";
import { StateManager } from "../state/manager.js";
import { archiveChapterVersion, readChapterUserBrief, readChapterVersion } from "../state/chapter-workspace.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext } from "../agents/base.js";
import type { AuditResult } from "../agents/continuity.js";
import { ObservationSchema, type Observation } from "../models/observation.js";
import type { RadarResult } from "../agents/radar.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import { ChapterMemoSchema, ChapterIntentSchema, ChapterTraceSchema, ContextPackageSchema, type ChapterMemo, type ChapterTrace, type ContextPackage } from "../models/input-governance.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import { buildLengthSpec, chapterLengthDelivery, countChapterLength, formatLengthCount, resolveLengthCountingMode, type LengthLanguage } from "../utils/length-metrics.js";
import {
  readCharacterContext,
  readStoryFrame,
  readVolumeMap,
} from "../utils/outline-paths.js";
import {
  createInitialRuntimeState,
  loadRuntimeStateSnapshot,
  loadRuntimeStateSnapshotAtChapter,
} from "../state/runtime-state-store.js";
import {
  renderChapterSummariesProjection,
  renderCurrentStateProjection,
  renderHooksProjection,
} from "../state/state-projections.js";
import { readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { reconcileChapterStateAfterReview, unresolvedStateObservation } from "./chapter-state-recovery.js";
import { persistChapterArtifacts } from "./chapter-persistence.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { WorkManifestSchema, type WorkManifest } from "../harness/contracts.js";
import { syncWorkSourceArtifacts, captureWorkSourceState, changedWorkSourcePaths } from "../harness/source-sync.js";
import { reviewChapterDraft } from "./chapter-review.js";
import { ChapterCheckpoint, chapterAuthorityHashes, chapterBookIdentity, assertChapterCheckpointBaseline } from "./chapter-checkpoint.js";
import { bootstrapLegacyAuditCheckpoint } from "./chapter-legacy-evidence.js";
import { isDeepStrictEqual } from "node:util";
import { isChapterResumeSafetyError } from "../agent/chapter-stage-context.js";
import { actionableFindings, reviewFindings, revisionModeFor, usageFromError } from "./auto-revision-policy.js";
import { validateChapterTruthPersistence } from "./chapter-truth-validation.js";
import { loadPersistedPlan, relativeToBookDir, savePersistedPlan } from "./persisted-governed-plan.js";
import { selectBookReferenceContext } from "../references/reference-context.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import { loadAvailableAgentSkills, mergeActivatedSkillGuidance } from "../skills/index.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { compileStyleGuide } from "../agents/style-guide.js";
import { compileImportSource, renderCompleteImportSource } from "../agents/import-context.js";

const CheckpointUsageSchema = z.object({ promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() });
const PreparedCheckpointSchema = z.object({
  externalContext: z.string().optional(), chapterIntent: z.string(), chapterMemo: ChapterMemoSchema,
  chapterIntentData: ChapterIntentSchema.optional(), contextPackage: ContextPackageSchema,
}).passthrough();
const PlanCheckpointSchema = z.object({ intent: ChapterIntentSchema, memo: ChapterMemoSchema, intentMarkdown: z.string(),
  plannerInputs: z.array(z.string()), runtimePath: z.string() });
const ContextCheckpointSchema = z.object({ contextPackage: ContextPackageSchema, trace: ChapterTraceSchema,
  contextPath: z.string(), tracePath: z.string() });
const DraftCheckpointSchema = z.object({
  output: z.object({ chapterNumber: z.number().int().positive(), title: z.string().min(1), content: z.string().min(1),
    wordCount: z.number().int().nonnegative(), tokenUsage: CheckpointUsageSchema }),
  draftVersion: z.object({ id: z.string().min(1) }).passthrough().optional(),
});
const AuditCheckpointSchema = z.object({
  content: z.string().min(1), wordCount: z.number().int().nonnegative(), totalUsage: CheckpointUsageSchema,
  review: z.object({ summary: z.string(), observations: z.array(ObservationSchema), unavailable: z.boolean().optional(),
    tokenUsage: CheckpointUsageSchema.optional(),
    reviewedArtifact: z.object({ workId: z.string(), artifactId: z.string(), revisionId: z.string() }).optional() }),
});
const RevisionCheckpointSchema = z.object({
  autoRevision: AutoRevisionOutcomeSchema, finalContent: z.string().min(1), candidateContent: z.string().optional(),
  candidateVersionId: z.string().optional(), pendingRevisionContext: ContextPackageSchema.optional(), totalUsage: CheckpointUsageSchema,
});
const RevisionCandidateCheckpointSchema = z.object({ content: z.string().min(1), candidateVersionId: z.string().min(1) });
const RuntimeSnapshotCheckpointSchema = z.object({ manifest: StateManifestSchema, currentState: CurrentStateStateSchema,
  hooks: HooksStateSchema, chapterSummaries: ChapterSummariesStateSchema });
const BaselineCheckpointSchema = z.object({ runtimeSnapshot: RuntimeSnapshotCheckpointSchema, authorityHashes: z.record(z.string()), bookIdentity: z.unknown() });
const StartedCheckpointSchema = z.object({ wordCount: z.number().int().positive().optional(), temperatureOverride: z.number().optional(), externalContext: z.string().optional() });
const PersistedCheckpointSchema = z.object({ chapterNumber: z.number().int().positive(), title: z.string(), content: z.string(),
  autoRevision: AutoRevisionOutcomeSchema, auditResult: AuditCheckpointSchema.shape.review,
  finalWordCount: z.number().int().nonnegative(), lengthTelemetry: z.unknown().optional(), totalUsage: CheckpointUsageSchema });
const PersistenceOutputCheckpointSchema = z.object({ chapterNumber: z.number().int().positive(), title: z.string(), content: z.string(),
  wordCount: z.number().int().nonnegative(), postSettlement: z.string(), runtimeStateDelta: RuntimeStateDeltaSchema,
  runtimeStateSnapshot: RuntimeSnapshotCheckpointSchema, updatedState: z.string(), updatedHooks: z.string(),
  updatedChapterSummaries: z.string(), runtimeStateApplied: z.boolean(), tokenUsage: CheckpointUsageSchema.optional() });
const SettlementCheckpointSchema = z.object({ candidate: z.boolean(), content: z.string(), persistenceOutput: PersistenceOutputCheckpointSchema,
  totalUsage: CheckpointUsageSchema });
const TruthCheckpointSchema = z.object({ validation: z.object({ consistent: z.boolean(), reconciliationRequired: z.boolean(),
  observations: z.array(ObservationSchema) }), persistenceOutput: PersistenceOutputCheckpointSchema });
const PostAuditCheckpointSchema = z.object({ autoRevision: AutoRevisionOutcomeSchema,
  candidateReview: AuditCheckpointSchema.shape.review.optional(), auditResult: AuditCheckpointSchema.shape.review,
  totalUsage: CheckpointUsageSchema, content: z.string() });

function mergeChapterRevisionInstructions(
  persistedBrief: string,
  currentInstruction?: string,
): string | undefined {
  const persisted = persistedBrief.trim();
  const current = currentInstruction?.trim() ?? "";
  if (!persisted) return current || undefined;
  if (!current || current === persisted) return persisted;
  return [
    "## Persisted chapter brief",
    persisted,
    "",
    "## Current revision instruction",
    current,
  ].join("\n");
}


export function buildSpinoffFoundationContext(
  parentCanon: string,
  direction: string | undefined,
  language: "zh" | "en",
): string {
  const dir = direction?.trim();
  if (language === "en") {
    return [
      "## This is a SIDE-STORY (番外)",
      dir ? `\n## Side-story direction\n${dir}` : "",
      `\n## Parent canon\n${parentCanon}`,
    ].filter(Boolean).join("\n");
  }
  return [
    "## 这是一部番外",
    dir ? `\n## 番外方向\n${dir}` : "",
    `\n## 正传正典\n${parentCanon}`,
  ].filter(Boolean).join("\n");
}

export function buildImportFoundationSource(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
): string {
  return renderCompleteImportSource(chapters, language);
}

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly defaultLLMConfig?: LLMConfig;
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly radarSources?: ReadonlyArray<RadarSource>;
  readonly externalContext?: string;
  /** Explicit chapter rewrite replaces the interrupted operation after confirmation. */
  readonly allowIncompleteRewrite?: boolean;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onContextCompression?: ContextCompressionCallback;
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterContextTraceSummary {
  readonly tracePath: string;
  readonly selectedSources: ReadonlyArray<string>;
  readonly protectedSources: ReadonlyArray<string>;
  readonly compressibleSources: ReadonlyArray<string>;
  readonly tokenBudget: ChapterTrace["tokenBudget"];
  readonly retrieval?: ChapterTrace["retrieval"];
  readonly compression?: ChapterTrace["compression"];
}

export interface ChapterPipelineResult {
  readonly delivery?: ReturnType<typeof chapterLengthDelivery>;
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly review: AuditResult;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
  readonly contextTrace?: ChapterContextTraceSummary;
  readonly autoRevision?: AutoRevisionOutcome;
}

export interface WriteChaptersOptions {
  readonly startChapterNumber?: number;
  readonly wordCount?: number;
  readonly temperatureOverride?: number;
  readonly externalContext?: string;
  readonly onChapterComplete?: (
    result: ChapterPipelineResult,
    completedCount: number,
    requestedCount: number,
  ) => void;
}

export interface ReviseResult {
  readonly changedRegion?:ReturnType<typeof changedSourceRegion>;
  readonly delivery?: ReturnType<typeof chapterLengthDelivery>;
  readonly chapterNumber: number;
  readonly wordCount: number;
  readonly changed: boolean;
  readonly observations: ReadonlyArray<Observation>;
  readonly lengthTelemetry?: LengthTelemetry;
}

export interface ImportChaptersInput {
  readonly continuationInstruction?: string;
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportChaptersResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}

export interface InitBookOptions {
  readonly externalContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
}

export class PipelineRunner {
  private readonly state: StateManager;
  private readonly config: PipelineConfig;
  private readonly agentClients = new Map<string, LLMClient>();
  private readonly operationContext = new AsyncLocalStorage<{
    readonly signal?: AbortSignal;
    readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
    readonly workerSkills?: (agent: string) => ReadonlyArray<ActivatedSkillGuidance>;
  }>();

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
    if (process.env.INKOS_OPENROUTER_FREE_ONLY === "1") {
      // Check all potential agent deployments before creating a Work or making
      // the first free API call. Otherwise a paid override could fail midway.
      clientWithModel(config.client, config.model);
      for (const agent of Object.keys(config.modelOverrides ?? {})) {
        this.resolveOverride(agent);
      }
    }
  }

  async runWithAbortSignal<T>(
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.runWithAgentContext({ signal }, task);
  }

  async runWithAgentContext<T>(
    context: {
      readonly signal?: AbortSignal;
      readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
      readonly workerSkills?: (agent: string) => ReadonlyArray<ActivatedSkillGuidance>;
    },
    task: () => Promise<T>,
  ): Promise<T> {
    const current = this.operationContext.getStore();
    const merged = {
      signal: context.signal ?? current?.signal,
      activatedSkills: context.activatedSkills ?? current?.activatedSkills,
      workerSkills: context.workerSkills ?? current?.workerSkills,
    };
    merged.signal?.throwIfAborted();
    return this.operationContext.run(merged, async () => {
      merged.signal?.throwIfAborted();
      return task();
    });
  }

  private currentAbortSignal(): AbortSignal | undefined {
    return this.operationContext.getStore()?.signal;
  }

  private currentActivatedSkills(agent: string): ReadonlyArray<ActivatedSkillGuidance> | undefined {
    const context = this.operationContext.getStore();
    const selected = context?.workerSkills?.(agent) ?? [];
    return mergeActivatedSkillGuidance(selected, context?.activatedSkills ?? []);
  }

  private throwIfOperationAborted(): void {
    this.currentAbortSignal()?.throwIfAborted();
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLanguage> {
    if (book.language) {
      return book.language;
    }

    return book.language;
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLanguage> {
    const book = await this.state.loadBookConfig(bookId);
    return this.resolveBookLanguage(book);
  }

  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(
      `${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`,
    );
  }

  private logInfo(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(this.localize(language, message));
  }

  private logWarn(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.warn(this.localize(language, message));
  }

  async prepareDraftBook(book: BookConfig): Promise<void> {
    book = BookConfigSchema.parse(book);
    let manifest: WorkManifest;
    try {
      manifest = await loadWorkManifest(this.config.projectRoot, book.id);
      if (!createBuiltInWorkProfileRegistry(this.config.projectRoot).require(manifest.profileId).capabilityIds.includes("longform")) {
        throw new Error(`Work "${book.id}" does not declare long-form production capability.`);
      }
      if (manifest.status !== "draft" && await this.state.isCompleteBookDirectory(this.state.bookDir(book.id))) {
        throw new Error(`Book "${book.id}" already exists as a completed Work.`);
      }
      manifest = WorkManifestSchema.parse({
        ...manifest,
        title: book.title,
        language: book.language,
        status: "draft",
        metadata: {
          ...manifest.metadata,
          ...(book.narrativeLanguage !== undefined ? { narrativeLanguage: book.narrativeLanguage } : {}),
          genre: book.genre,
          platform: book.platform,
          ...(book.fanficMode ? { fanficMode: book.fanficMode } : {}),
        },
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      manifest = createWorkManifest({
        id: book.id,
        title: book.title,
        profileId: "longform-novel",
        language: book.language,
        status: "draft",
        now: book.createdAt,
        lineage: book.parentBookId
          ? [{ relation: "derived-from", sourceWorkId: book.parentBookId }]
          : [],
        metadata: {
          genre: book.genre,
          platform: book.platform,
          ...(book.narrativeLanguage !== undefined ? { narrativeLanguage: book.narrativeLanguage } : {}),
          ...(book.fanficMode ? { fanficMode: book.fanficMode } : {}),
        },
      });
    }
    await saveWorkManifest(this.config.projectRoot, manifest);
    await this.state.saveBookConfigAt(this.state.bookDir(book.id), book);
    await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: false });
  }

  private async preserveFailedWork(bookId: string, originalError: unknown): Promise<never> {
    try {
      const manifest = await loadWorkManifest(this.config.projectRoot, bookId);
      await saveWorkManifest(this.config.projectRoot, WorkManifestSchema.parse({
        ...manifest,
        status: "draft",
        updatedAt: new Date().toISOString(),
      }));
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: false });
    } catch (recordError) {
      if ((recordError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([originalError, recordError], `Work creation failed and candidate artifacts could not be recorded: ${bookId}`);
      }
    }
    throw new Error(
      `Work creation is incomplete; draft Work "${bookId}" and its candidate artifacts were preserved. ${originalError instanceof Error ? originalError.message : String(originalError)}`,
      { cause: originalError },
    );
  }


  private resolveOverride(agentName: string): { model: string; client: LLMClient } {
    const override = this.config.modelOverrides?.[agentName];
    if (!override) {
      return { model: this.config.model, client: this.config.client };
    }
    const selected: AgentLLMOverride = typeof override === "string" ? { model: override } : override;
    if (typeof override === "string" && override === this.config.model) return { model: override, client: this.config.client };
    const cacheKey = JSON.stringify(selected);
    const cached = this.agentClients.get(cacheKey);
    if (cached) return { model: selected.model, client: cached };
    const { apiKeyEnv, ...settings } = selected;
    const client = clientWithModel(this.config.client, selected.model, {
      ...settings,
      ...(selected.baseUrl && selected.baseUrl !== this.config.client._piModel?.baseUrl ? { service: "custom" } : {}),
      ...(apiKeyEnv ? { apiKey: process.env[apiKeyEnv] ?? "" } : {}),
    });
    this.agentClients.set(cacheKey, client);
    return { model: selected.model, client };
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    const { model, client } = this.resolveOverride(agent);
    return {
      client,
      model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger?.child(agent),
      onStreamProgress: this.config.onStreamProgress,
      signal: this.currentAbortSignal(),
      activatedSkills: this.currentActivatedSkills(agent),
    };
  }

  public createAgentContext(agent: string, bookId?: string): AgentContext {
    return this.agentCtxFor(agent, bookId);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by OpenClaw or agent mode)
  // ---------------------------------------------------------------------------

  async runRadar(): Promise<RadarResult> {
    const available = await loadAvailableAgentSkills({ projectRoot: this.config.projectRoot });
    const marketSkill = [...available.skills].reverse().find((skill) => skill.id === "inkos-long-market-research");
    if (!marketSkill) throw new Error("Radar requires unavailable skill: inkos-long-market-research");
    const baseContext = this.agentCtxFor("radar");
    const radar = new RadarAgent({
      ...baseContext,
      activatedSkills: mergeActivatedSkillGuidance(
        baseContext.activatedSkills ?? [],
        [{ skill: marketSkill, resources: [] }],
      ),
    }, this.config.radarSources);
    return radar.scan();
  }

  async initBook(book: BookConfig, options: InitBookOptions = {}): Promise<void> {
    book = BookConfigSchema.parse(book);
    await this.prepareDraftBook(book);
    if (await this.state.isCompleteBookDirectory(this.state.bookDir(book.id))) {
      const saved = await loadWorkManifest(this.config.projectRoot, book.id);
      const foundationPaths = saved.artifacts.flatMap(artifact => artifact.revisions.map(revision => revision.path))
        .filter(path => path === "source/book.json" || path === "source/chapters/index.json" || path.startsWith("source/story/"));
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: true, acceptPaths: foundationPaths });
      return;
    }
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const bookDir = this.state.bookDir(book.id);
    const stagingBookDir = join(
      this.state.booksDir,
      `.tmp-book-create-${book.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stageLanguage = await this.resolveBookLanguage(book);
    const effectiveExternalContext = options.externalContext ?? this.config.externalContext;
    if (effectiveExternalContext?.trim()) {
      await commitAtomicFileSet({ rootDir: bookDir, writes: [
        { relativePath: "story/brief.md", content: effectiveExternalContext },
      ] });
    }

    this.logStage(stageLanguage, { zh: "生成基础设定", en: "generating foundation" });
    const foundation = await architect.generateFoundation(book, effectiveExternalContext, undefined, {
        onOutline: (outline) => this.persistDraftFoundationOutline(book.id, outline),
      }).catch((error) => this.preserveFailedWork(book.id, error));
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfigAt(stagingBookDir, book);

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        stagingBookDir,
        foundation,
        book.language,
        "init",
        resolveNarrativeLanguage(book),
      );

      if (effectiveExternalContext && effectiveExternalContext.trim().length > 0) {
        const storyDir = join(stagingBookDir, "story");
        await mkdir(storyDir, { recursive: true });
        await writeFile(join(storyDir, "brief.md"), effectiveExternalContext, "utf-8");
      }

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocumentsAt(
        stagingBookDir,
        book.language,
        options.authorIntent ?? effectiveExternalContext,
      );
      if (options.currentFocus?.trim()) {
        await writeFile(
          join(stagingBookDir, "story", "current_focus.md"),
          options.currentFocus.trimEnd() + "\n",
          "utf-8",
        );
      }

      await this.state.saveChapterIndexAt(stagingBookDir, []);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await this.state.snapshotStateAt(stagingBookDir, 0);

      if (await this.pathExists(bookDir)) {
        if (await this.state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${book.id}" already exists as a Work. Use a different title or delete the existing book first.`);
        }
      }
      const writes: Array<{ relativePath: string; content: string }> = [];
      const collect = async (directory: string): Promise<void> => {
        for (const entry of await readdir(join(stagingBookDir, directory), { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collect(path);
          else if (entry.isFile()) writes.push({ relativePath: path, content: await readFile(join(stagingBookDir, path), "utf8") });
        }
      };
      await collect("");
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: true,
        writes: writes.map(write => ({...write,relativePath: join("works", book.id, "source", write.relativePath)})),
      });
      await rm(stagingBookDir, { recursive: true, force: true });
    } catch (error) {
      try {
        await rm(stagingBookDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Work creation failed and staging cleanup was incomplete: ${book.id}`,
        );
      }
      await this.preserveFailedWork(book.id, error);
    }
  }

  private async persistDraftFoundationOutline(
    bookId: string,
    outline: { readonly storyFrame: string; readonly volumeMap: string },
  ): Promise<void> {
    await commitAtomicFileSet({
      rootDir: this.state.bookDir(bookId),
      writes: [
        { relativePath: join("story", "outline", "story_frame.md"), content: `${outline.storyFrame.trim()}\n` },
        { relativePath: join("story", "outline", "volume_map.md"), content: `${outline.volumeMap.trim()}\n` },
      ],
    });
    await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: false });
  }

  /** Revise an existing Work foundation without touching runtime chapter state. */
  async reviseFoundation(bookId: string, feedback: string): Promise<void> {
    const sourceBefore = await captureWorkSourceState(this.config.projectRoot, bookId);
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    // Accepting imported canon can make the Work active before its foundation
    // exists. Recovery depends on persisted readiness, not that coarse status.
    if (!(await this.state.isCompleteBookDirectory(bookDir))
      || !(await this.pathExists(join(storyDir, "state", "manifest.json")))) {
      await this.recoverDraftFoundation(bookId, feedback);
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(storyDir, `.backup-foundation-${timestamp}`);
    await mkdir(backupDir, { recursive: true });
    await this.copyDirShallow(join(storyDir, "outline"), join(backupDir, "outline"));
    await this.copyDirRecursive(join(storyDir, "roles"), join(backupDir, "roles"));
    await writeFile(
      join(backupDir, "book_rules.md"),
      await readFile(join(storyDir, "book_rules.md"), "utf-8"),
      "utf-8",
    );

    const book = await this.state.loadBookConfig(bookId);
    const [oldStoryFrame, oldVolumeMap, oldBookRules, oldRoles] = await Promise.all([
      readStoryFrame(bookDir),
      readVolumeMap(bookDir),
      readFile(join(storyDir, "book_rules.md"), "utf-8"),
      readCharacterContext(bookDir),
    ]);

    const architect = new ArchitectAgent(this.agentCtxFor("architect", bookId));
    const foundation = await architect.generateFoundation(book, undefined, undefined, {
      reviseFrom: {
        storyFrame: oldStoryFrame,
        volumeMap: oldVolumeMap,
        bookRules: oldBookRules,
        roles: oldRoles,
        userFeedback: feedback,
      },
    });

    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      book.language,
      "revise",
      resolveNarrativeLanguage(book),
    );
    await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true , acceptPaths: await changedWorkSourcePaths(this.config.projectRoot, bookId, sourceBefore) });
  }

  /** Complete a preserved draft without discarding its canon or revision history. */
  private async recoverDraftFoundation(bookId: string, feedback: string): Promise<void> {
    const sourceBefore = await captureWorkSourceState(this.config.projectRoot, bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapters = await this.state.loadChapterIndex(bookId);
    if (chapters.length > 0) {
      throw Object.assign(new Error("Cannot initialize draft state over existing chapters."), { code: "DRAFT_HAS_CHAPTERS" });
    }
    const book = await this.state.loadBookConfig(bookId);
    const context: string[] = [];
    for (const path of ["brief.md", "author_intent.md", "parent_canon.md", "fanfic_canon.md", "style_guide.md", "outline/story_frame.md", "outline/volume_map.md"]) {
      try { context.push(`## ${path}\n${await readFile(join(bookDir, "story", path), "utf8")}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    context.push(feedback);
    const architect = new ArchitectAgent(this.agentCtxFor("architect", bookId));
    try {
      const foundation = await architect.generateFoundation(book, context.join("\n\n"));
      await architect.writeFoundationFiles(bookDir, foundation, book.language, "revise", resolveNarrativeLanguage(book));
      if (!(await this.pathExists(join(bookDir, "story", "state", "manifest.json")))) {
        await createInitialRuntimeState({ bookDir, language: book.language, projectionLanguage: resolveNarrativeLanguage(book), hooks: foundation.initialHooks });
      }
      await this.state.ensureControlDocuments(bookId, feedback);
      await this.state.saveChapterIndex(bookId, []);
      await this.state.snapshotState(bookId, 0);
      const referencePath = join(bookDir, "story", "imitation_reference.md");
      if (await this.pathExists(referencePath)) {
        await this.generateStyleGuide(bookId, await readFile(referencePath, "utf8"), "Preserved imitation reference");
      }
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true , acceptPaths: ["source/book.json", ...await changedWorkSourcePaths(this.config.projectRoot, bookId, sourceBefore)] });
    } catch (error) {
      await this.preserveFailedWork(bookId, error);
    }
  }

  private async copyDirShallow(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const content = await readFile(join(src, entry.name), "utf-8");
      await writeFile(join(dest, entry.name), content, "utf-8");
    }));
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        const content = await readFile(srcPath, "utf-8");
        await writeFile(destPath, content, "utf-8");
      }
    }
  }

  /** Import external source material and generate fanfic_canon.md */
  async importFanficCanon(
    bookId: string,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
    options: { readonly accept?: boolean } = {},
  ): Promise<string> {
    const { FanficCanonImporter } = await import("../agents/fanfic-canon-importer.js");
    const importer = new FanficCanonImporter(this.agentCtxFor("fanfic-canon-importer", bookId));
    const language = await this.resolveBookLanguageById(bookId);
    const result = await importer.importFromText(sourceText, sourceName, fanficMode, language);

    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "fanfic_canon.md"), result.fullDocument, "utf-8");

    await syncWorkSourceArtifacts({
      projectRoot: this.config.projectRoot,
      workId: bookId,
      accept: options.accept !== false,
      acceptPaths: ["source/story/fanfic_canon.md"],
    });
    return result.fullDocument;
  }

  /** One-step fanfic book creation: create book + import canon + generate foundation */
  async initFanficBook(
    book: BookConfig,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<void> {
    const sourceBefore = await captureWorkSourceState(this.config.projectRoot, book.id);
    const stageLanguage = await this.resolveBookLanguage(book);
    await this.prepareDraftBook(book);
    const bookDir = this.state.bookDir(book.id);
    try {
      this.logStage(stageLanguage, { zh: "导入同人正典", en: "importing fanfic canon" });
      const fanficCanon = await this.importFanficCanon(book.id, sourceText, sourceName, fanficMode, { accept: false });

      const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
      this.logStage(stageLanguage, { zh: "生成同人基础设定", en: "generating fanfic foundation" });
      const foundation = await architect.generateFanficFoundation(book, fanficCanon, fanficMode, undefined, {
        onOutline: (outline) => this.persistDraftFoundationOutline(book.id, outline),
      });
      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        bookDir,
        foundation,
        book.language,
        "init",
        resolveNarrativeLanguage(book),
      );
      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocuments(book.id, this.config.externalContext);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await mkdir(join(bookDir, "chapters"), { recursive: true });
      await this.state.saveChapterIndex(book.id, []);
      await this.state.snapshotState(book.id, 0);
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: true , acceptPaths: ["source/book.json", ...await changedWorkSourcePaths(this.config.projectRoot, book.id, sourceBefore)] });
    } catch (error) {
      await this.preserveFailedWork(book.id, error);
    }
  }

  /**
   * Create a side-story (番外) book: a standalone companion that inherits a
   * parent book's world/characters via parent_canon.md, but tells an INDEPENDENT
   * side plot that does not advance or contradict the parent's main-line state.
   * Reuses importCanon (which already builds the parent-canon reference for
   * side-story writing) + the standard original-foundation architect path.
   */
  async initSpinoffBook(book: BookConfig, parentBookId: string, direction?: string): Promise<void> {
    const sourceBefore = await captureWorkSourceState(this.config.projectRoot, book.id);
    const stageLanguage = await this.resolveBookLanguage(book);
    await this.prepareDraftBook(book);
    const bookDir = this.state.bookDir(book.id);
    if (direction?.trim()) await commitAtomicFileSet({ rootDir: bookDir, writes: [{ relativePath: "story/brief.md", content: direction }] });
    try {
      this.logStage(stageLanguage, { zh: "导入正传正典参照", en: "importing parent canon" });
      const parentCanon = await this.importCanon(book.id, parentBookId);

      const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
      const resolvedLanguage = book.language;
      const spinoffContext = buildSpinoffFoundationContext(parentCanon, direction, resolvedLanguage);

      this.logStage(stageLanguage, { zh: "生成番外基础设定", en: "generating side-story foundation" });
      const foundation = await architect.generateFoundation(book, spinoffContext, undefined, {
        onOutline: (outline) => this.persistDraftFoundationOutline(book.id, outline),
      });

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(bookDir, foundation, book.language, "init", resolveNarrativeLanguage(book));

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocuments(book.id, direction?.trim() || this.config.externalContext);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await mkdir(join(bookDir, "chapters"), { recursive: true });
      await this.state.saveChapterIndex(book.id, []);
      await this.state.snapshotState(book.id, 0);
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: true , acceptPaths: ["source/book.json", ...await changedWorkSourcePaths(this.config.projectRoot, book.id, sourceBefore)] });
    } catch (error) {
      await this.preserveFailedWork(book.id, error);
    }
  }

  /**
   * Create an imitation (仿写) book: an ORIGINAL story whose prose imitates the
   * voice of a reference work. The architect builds an original foundation from
   * the user's story idea; the reference text becomes the book's style_guide.md
   * so the writer mimics its style. The style guide is mandatory here (imitation
   * is the whole point), so a failure to generate it surfaces rather than being
   * silently skipped.
   */
  async initImitationBook(
    book: BookConfig,
    referenceText: string,
    storyIdea: string,
    sourceName?: string,
  ): Promise<void> {
    const sourceBefore = await captureWorkSourceState(this.config.projectRoot, book.id);
    await this.prepareDraftBook(book);
    await commitAtomicFileSet({ rootDir: this.state.bookDir(book.id), writes: [
      { relativePath: "story/imitation_reference.md", content: referenceText },
      { relativePath: "story/brief.md", content: storyIdea },
    ] });
    try {
      if (!(await this.state.isCompleteBookDirectory(this.state.bookDir(book.id)))) {
        await this.initBook(book, { externalContext: storyIdea });
      }
      const manifest = await loadWorkManifest(this.config.projectRoot, book.id);
      await saveWorkManifest(this.config.projectRoot, WorkManifestSchema.parse({
        ...manifest,
        status: "draft",
        updatedAt: new Date().toISOString(),
      }));
      const stageLanguage = await this.resolveBookLanguage(book);
      this.logStage(stageLanguage, { zh: "提取参考作品风格指纹", en: "extracting reference style fingerprint" });
      await this.generateStyleGuide(book.id, referenceText, sourceName?.trim() || "reference");
      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: book.id, accept: true , acceptPaths: ["source/book.json", ...await changedWorkSourcePaths(this.config.projectRoot, book.id, sourceBefore)] });
    } catch (error) {
      await this.preserveFailedWork(book.id, error);
    }
  }

  /** Review the existing chapter and save observations without replanning its story. */
  async reviewChapter(bookId: string, chapterNumber?: number): Promise<AuditResult & { readonly chapterNumber: number; readonly delivery?: ReturnType<typeof chapterLengthDelivery> }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
    if (targetChapter < 1) {
      throw new Error(`No chapters to audit for "${bookId}"`);
    }

    const content = await this.readChapterContent(bookDir, targetChapter);
    const chapterBrief = await readChapterUserBrief(bookDir, targetChapter);
    const governed = await this.prepareExistingChapterContext(book,targetChapter,
      chapterBrief ?? (book.language==='en'?`Review existing chapter ${targetChapter}.`:`审查现有第${targetChapter}章。`));
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const language = book.language;
    this.logStage(language, {
      zh: `审计第${targetChapter}章`,
      en: `auditing chapter ${targetChapter}`,
    });
    const evaluation = await this.collectReviewObservations({
      auditor,
      book,
      bookDir,
      chapterContent: content,
      chapterNumber: targetChapter,
      language,
      auditOptions: { contextPackage: governed.contextPackage },
    });
    const result: AuditResult = evaluation;

    // Update index with audit result
    const index = await this.state.loadChapterIndex(bookId);
    const updated = index.map((ch) =>
      ch.number === targetChapter
        ? {
            ...ch,
            updatedAt: new Date().toISOString(),
            observations: [...result.observations],
          }
        : ch,
    );
    await this.state.saveChapterIndex(bookId, updated);

    await this.emitWebhook("review-complete", bookId, targetChapter, {
      summary: result.summary,
      observationCount: result.observations.length,
    });

    await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true, acceptPaths: ["source/chapters/index.json"] });
    const spec=buildLengthSpec(book.chapterWordCount,book.language,book);
    const delivery=chapterLengthDelivery(countChapterLength(content,spec.countingMode),spec);
    return { ...result, chapterNumber: targetChapter,...(delivery?{delivery}:{}) };
  }

  /** Revise the latest (or specified) chapter from user direction and review observations. */
  async reviseDraft(bookId: string, chapterNumber?: number, mode: ReviseMode = DEFAULT_REVISE_MODE, externalContext?: string, editScope?:{readonly targetText?:string}): Promise<ReviseResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
    const sourceBefore = await captureWorkSourceState(this.config.projectRoot, bookId);
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
      if (targetChapter < 1) {
        throw new Error(`No chapters to revise for "${bookId}"`);
      }

      const stageLanguage = await this.resolveBookLanguage(book);
      // Read the current review observations from the index.
      this.logStage(stageLanguage, {
        zh: `加载第${targetChapter}章修订上下文`,
        en: `loading revision context for chapter ${targetChapter}`,
      });
      const index = await this.state.loadChapterIndex(bookId);
      const chapterMeta = index.find((ch) => ch.number === targetChapter);
      if (!chapterMeta) {
        throw new Error(`Chapter ${targetChapter} not found in index`);
      }
      const latestChapter = index.length > 0
        ? Math.max(...index.map((chapter) => chapter.number))
        : targetChapter;
      const isLatestChapter = targetChapter === latestChapter;

      const content = await this.readChapterContent(bookDir, targetChapter);
      const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
      const language = book.language;
      const countingMode = resolveLengthCountingMode(language, book.narrativeLanguage);
      const persistedChapterBrief = await readChapterUserBrief(bookDir, targetChapter);
      const effectiveExternalContext = mergeChapterRevisionInstructions(
        persistedChapterBrief,
        externalContext ?? this.config.externalContext,
      );
      const revisionIntent=effectiveExternalContext?.trim() || (language==='en'
        ? `Review and revise the existing chapter ${targetChapter} in ${mode} mode.`
        : `审查并以 ${mode} 模式修订现有第${targetChapter}章。`);
      const reviseControlInput=await this.prepareExistingChapterContext(book,targetChapter,revisionIntent);
      const explicitRevisionRequested = Boolean(effectiveExternalContext?.trim())
        || editScope?.targetText !== undefined
        || mode === "rewrite"
        || mode === "rework";
      const preRevision = explicitRevisionRequested
        ? { observations: [], summary: language === "en" ? "User-directed revision" : "用户定向修订" }
        : await this.collectReviewObservations({
            auditor,
            book,
            bookDir,
            chapterContent: content,
            chapterNumber: targetChapter,
            language,
            auditOptions: {
              contextPackage: reviseControlInput.contextPackage,
            },
          });
      if (!explicitRevisionRequested && preRevision.observations.length === 0) {
        const delivery=chapterLengthDelivery(countChapterLength(content,countingMode),
          buildLengthSpec(book.chapterWordCount,language,book));
        return {
          chapterNumber: targetChapter,
          wordCount: countChapterLength(content, countingMode),
          changed: false,
          observations: [],
          ...(delivery?{delivery}:{}),
        };
      }

      const chapterLengthTarget = chapterMeta.lengthTelemetry?.target ?? book.chapterWordCount;
      const lengthLanguage = chapterMeta.lengthTelemetry?.countingMode === "en_words"
        ? "en"
        : language;
      const lengthSpec = buildLengthSpec(
        chapterLengthTarget,
        lengthLanguage,
        book,
      );
      const baselineChapter = targetChapter - 1;
      const baselineSnapshot = await loadRuntimeStateSnapshotAtChapter({
        bookDir,
        chapterNumber: baselineChapter,
        language,
      }).catch((error) => {
        throw new Error(
          `Cannot revise chapter ${targetChapter} safely: baseline snapshot ${baselineChapter} is unavailable (${String(error)})`,
        );
      });
      const stateLanguage = resolveNarrativeLanguage(book);
      const baselineState = renderCurrentStateProjection(baselineSnapshot.currentState, stateLanguage);
      const baselineHooks = renderHooksProjection(baselineSnapshot.hooks, stateLanguage);
      const [authorityStoryFrame, authorityBookRules] = await Promise.all([
        readStoryFrame(bookDir), readFile(join(bookDir, "story", "book_rules.md"), "utf-8"),
      ]);
      const authorityContext = {storyFrame:authorityStoryFrame,bookRules:authorityBookRules,
        chapterSummaries:renderChapterSummariesProjection(baselineSnapshot.chapterSummaries,stateLanguage)};

      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      this.logStage(stageLanguage, {
        zh: `修订第${targetChapter}章`,
        en: `revising chapter ${targetChapter}`,
      });
      const reviseOutput = await reviser.reviseChapter(
        bookDir,
        content,
        targetChapter,
        preRevision.observations,
        mode,
        book.genre,
        {
          language,
          narrativeLanguage: resolveNarrativeLanguage(book),
          chapterTitle:chapterMeta.title,
          targetText:editScope?.targetText,
          contextPackage: reviseControlInput.contextPackage,
          lengthSpec,
        },
      );

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }
      const revisedContent = reviseOutput.revisedContent;
      const changed = revisedContent !== content;
      const revisedCount = countChapterLength(revisedContent, lengthSpec.countingMode);
      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      const stateValidator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
      let settledRevision = await writer.settleChapterState({
        book,
        bookDir,
        chapterNumber: targetChapter,
        baselineChapter,
        title: chapterMeta.title,
        content: revisedContent,
        chapterIntent: reviseControlInput.chapterIntent,
        contextPackage: reviseControlInput.contextPackage,
      });
      let stateValidation = await stateValidator.validate(
        revisedContent,
        targetChapter,
        baselineState,
        settledRevision.updatedState,
        baselineHooks,
        settledRevision.updatedHooks,
        language,
        authorityContext,
        stateLanguage,
      );
      if (!stateValidation.consistent || stateValidation.reconciliationRequired) {
        const recovery = await reconcileChapterStateAfterReview({
          writer,
          validator: stateValidator,
          book,
          bookDir,
          chapterNumber: targetChapter,
          baselineChapter,
          title: chapterMeta.title,
          content: revisedContent,
          reducedControlInput: {
            chapterIntent: reviseControlInput.chapterIntent,
            contextPackage: reviseControlInput.contextPackage,
          },
          oldState: baselineState,
          oldHooks: baselineHooks,
          originalValidation: stateValidation,
          authorityContext,
          language,
          logger: this.config.logger,
        });
        settledRevision = recovery.output;
        stateValidation = recovery.validation;
      }
      const postRevision = await this.collectReviewObservations({
        auditor,
        book,
        bookDir,
        chapterContent: revisedContent,
        chapterNumber: targetChapter,
        language,
        auditOptions: {
          temperature: 0,
          contextPackage: reviseControlInput.contextPackage,
        },
      });
      const postRevisionObservations = [
        ...postRevision.observations,
        ...(stateValidation.observations.length > 0
          ? stateValidation.observations
          : !stateValidation.consistent || stateValidation.reconciliationRequired
            ? [unresolvedStateObservation(resolveNarrativeLanguage(book))]
            : []),
      ];
      const revisionBaseCount = countChapterLength(content, lengthSpec.countingMode);
      const lengthTelemetry = this.buildLengthTelemetry({
        lengthSpec,
        writerCount: revisionBaseCount,
        postReviseCount: revisedCount,
        finalCount: revisedCount,
        repairApplied: revisedContent !== content,
      });

      const remainingObservations = postRevisionObservations;

      // Save revised chapter file
      this.logStage(stageLanguage, {
        zh: `落盘第${targetChapter}章修订结果`,
        en: `persisting revision for chapter ${targetChapter}`,
      });
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(targetChapter).padStart(4, "0");
      const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!existingFile) {
        throw new Error(`Chapter ${targetChapter} file not found in ${chaptersDir} (expected filename starting with ${paddedNum})`);
      }
      if (changed) await archiveChapterVersion(bookDir, targetChapter, content, "revision");
      const reviseLang = book.language;

      const downstreamRevisionNotice = language === "en"
        ? `Chapter ${targetChapter} changed; re-review this downstream chapter for continuity.`
        : `第${targetChapter}章已重写，请重新检查本章与前文的连续性。`;
      const updatedIndex = index.map((ch) => {
        if (ch.number === targetChapter) {
          return {
            ...ch,
            wordCount: revisedCount,
            updatedAt: new Date().toISOString(),
            observations: [...postRevisionObservations],
            provenance: "edited" as const,
            lengthTelemetry,
          };
        }
        if (ch.number > targetChapter) {
          return {
            ...ch,
            updatedAt: new Date().toISOString(),
            observations: [
              ...ch.observations.filter((observation) => observation.code !== "upstream-revision"),
              {
                code: "upstream-revision",
                summary: downstreamRevisionNotice,
                evidence: [],
              },
            ],
          };
        }
        return ch;
      });

      // Only the latest chapter owns current truth. Reworking an older chapter
      // invalidates its descendants, but must not rewind the live story state.
      if (isLatestChapter) {
        await writer.saveChapter(bookDir, settledRevision, reviseLang, updatedIndex, resolveNarrativeLanguage(book));
      } else {
        await commitAtomicFileSet({
          rootDir: bookDir,
          writes: [
            {
              relativePath: join("chapters", existingFile),
              content: renderChapterDocument(targetChapter,chapterMeta.title,revisedContent,book.narrativeLanguage==='ru'?'ru':reviseLang),
            },
            {
              relativePath: join("chapters", "index.json"),
              content: `${JSON.stringify(updatedIndex, null, 2)}\n`,
            },
          ],
        });
      }

      // Re-snapshot
      this.logStage(stageLanguage, {
        zh: `更新第${targetChapter}章索引与快照`,
        en: `updating chapter index and snapshots for chapter ${targetChapter}`,
      });

      await this.emitWebhook("revision-complete", bookId, targetChapter, {
        wordCount: revisedCount,
        observationCount: remainingObservations.length,
      });

      await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true , acceptPaths: await changedWorkSourcePaths(this.config.projectRoot, bookId, sourceBefore) });
      return {
        chapterNumber: targetChapter,
        wordCount: revisedCount,
        changed,
        changedRegion:changedSourceRegion(chapterDocumentBody(content,targetChapter,chapterMeta.title,language),revisedContent),
        observations: remainingObservations,
        lengthTelemetry,
        ...(chapterLengthDelivery(revisedCount,lengthSpec)?{delivery:chapterLengthDelivery(revisedCount,lengthSpec)}:{}),
      };
    } finally {
      await releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Long-form production capability
  // ---------------------------------------------------------------------------

  async writeNextChapter(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<ChapterPipelineResult> {
    this.throwIfOperationAborted();
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const result = await this._writeNextChapterLocked(
        bookId,
        wordCount,
        temperatureOverride,
        externalContext ?? this.config.externalContext,
      );
      return result;
    } finally {
      await releaseLock();
    }
  }

  /** Continue the latest saved chapter operation without re-running completed model stages. */
  async resumeChapter(bookId: string, requestedChapter?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const index = await this.state.loadChapterIndex(bookId);
      const sourceBefore = await captureWorkSourceState(this.config.projectRoot, bookId);
      let checkpoint = requestedChapter === undefined
        ? await ChapterCheckpoint.latestForBook(this.config.projectRoot, bookId)
        : await ChapterCheckpoint.latest(this.config.projectRoot, bookId, requestedChapter);
      const latestChapter = index.reduce((latest, item) => Math.max(latest, item.number), 0);
      const legacyChapter = requestedChapter ?? latestChapter;
      if ((!checkpoint || (requestedChapter === undefined && checkpoint.chapter < latestChapter)) && legacyChapter > 0) {
        const chapter = index.find(item => item.number === legacyChapter);
        if (chapter && chapter.number === latestChapter) checkpoint = await bootstrapLegacyAuditCheckpoint({
          projectRoot: this.config.projectRoot, bookId, bookDir, book, chapter, sourceState: sourceBefore,
          currentContent: await this.readChapterContent(bookDir, chapter.number),
        });
      }
      if (!checkpoint) throw Object.assign(new Error("No chapter checkpoint found for this book"), { code: "CHAPTER_CHECKPOINT_NOT_FOUND" });
      const chapterNumber = checkpoint.chapter;
      if (index.some(chapter => chapter.number > chapterNumber)) {
        throw Object.assign(new Error("Cannot resume a chapter after later chapters have been saved"), { code: "CHAPTER_RESUME_NOT_LATEST" });
      }
      const chapterPersisted = index.some(chapter => chapter.number === chapterNumber);
      if (!chapterPersisted && await this.state.getNextChapterNumber(bookId) !== chapterNumber) {
        throw Object.assign(new Error("Checkpoint does not refer to the next chapter"), { code: "CHAPTER_RESUME_NUMBER_CONFLICT" });
      }
      const started = checkpoint.completed("started", StartedCheckpointSchema);
      if (!started) throw new Error("Chapter checkpoint has no operation settings");
      const liveSnapshot = await loadRuntimeStateSnapshot(bookDir);
      if (!checkpoint.latestRecord("baseline") && !chapterPersisted
        && !checkpoint.hasStartedStage()
        && !checkpoint.latestRecord("plan") && !checkpoint.latestRecord("context") && !checkpoint.latestRecord("draft")) {
        await checkpoint.record("baseline", "completed", { runtimeSnapshot: liveSnapshot,
          authorityHashes: chapterAuthorityHashes(sourceBefore, chapterNumber), bookIdentity: chapterBookIdentity(book) });
      }
      const baselineSnapshot = chapterPersisted
        ? await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber: chapterNumber - 1, language: book.language })
        : liveSnapshot;
      assertChapterCheckpointBaseline(checkpoint.latestRecord("baseline"), sourceBefore, baselineSnapshot, book, chapterNumber);

      if (chapterPersisted) {
        const currentContent = await this.readChapterContent(bookDir, chapterNumber);
        const savedTruth = checkpoint.matching("state-validation", TruthCheckpointSchema, item =>
          item.persistenceOutput.content === currentContent && isDeepStrictEqual(item.persistenceOutput.runtimeStateSnapshot, liveSnapshot));
        if (!savedTruth) {
          throw Object.assign(new Error("Saved chapter or state changed since the checkpoint"), { code: "CHAPTER_RESUME_CHAPTER_CHANGED" });
        }
      }
      const completed = checkpoint.completed("persisted", PersistedCheckpointSchema);
      if (completed) return { chapterNumber, title: completed.title, wordCount: completed.finalWordCount,
        review: completed.auditResult, autoRevision: completed.autoRevision, tokenUsage: completed.totalUsage };

      const result = await this._executeNextChapterLocked(bookId, started.wordCount, started.temperatureOverride,
        started.externalContext, { checkpoint, chapterNumber, chapterPersisted }, async () => {
          await syncWorkSourceArtifacts({ projectRoot: this.config.projectRoot, workId: bookId, accept: true,
            acceptPaths: await changedWorkSourcePaths(this.config.projectRoot, bookId, sourceBefore) });
        });
      return result;
    } finally {
      await releaseLock();
    }
  }

  async writeChapters(
    bookId: string,
    chapterCount: number,
    options: WriteChaptersOptions = {},
  ): Promise<ReadonlyArray<ChapterPipelineResult>> {
    if (!Number.isInteger(chapterCount) || chapterCount < 1) {
      throw new Error(`chapterCount must be a positive integer; received ${chapterCount}.`);
    }

    this.throwIfOperationAborted();
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      if (options.startChapterNumber !== undefined) {
        const startChapterNumber = options.startChapterNumber;
        if (!Number.isInteger(startChapterNumber) || startChapterNumber < 1) {
          throw Object.assign(new Error("startChapterNumber must be a positive integer."), { code: "CHAPTER_WRITE_RANGE_INVALID" });
        }
        const nextChapterNumber = await this.state.getNextChapterNumber(bookId);
        if (startChapterNumber !== nextChapterNumber) {
          throw Object.assign(new Error("The requested chapter range does not begin at the next unwritten chapter."), {
            code: "CHAPTER_WRITE_RANGE_CONFLICT", workId: bookId,
            requestedRange: { startChapterNumber, endChapterNumber: startChapterNumber + chapterCount - 1 },
            nextChapterNumber,
            recovery: { action: "workspace__inspect_work", parameters: { workId: bookId },
              requestedRange: { startChapterNumber, endChapterNumber: startChapterNumber + chapterCount - 1 }, nextChapterNumber,
              reason: "Inspect the persisted chapters. Review, revise or export existing targets; write only the still-missing range authorized by the author." },
          });
        }
      }
      const results: ChapterPipelineResult[] = [];
      for (let index = 0; index < chapterCount; index += 1) {
        this.throwIfOperationAborted();
        const result = await this._writeNextChapterLocked(
          bookId,
          options.wordCount,
          options.temperatureOverride,
          options.externalContext ?? this.config.externalContext,
        );
        results.push(result);
        options.onChapterComplete?.(result, results.length, chapterCount);
      }
      return results;
    } finally {
      await releaseLock();
    }
  }

  async resyncChapterStateAndAudit(
    bookId: string,
    chapterNumber?: number,
    options: { readonly allowNewHooks?: boolean } = {},
  ): Promise<{
    readonly chapter: ChapterPipelineResult;
    readonly audit: AuditResult & { readonly chapterNumber: number };
  }> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const sourceBefore = await captureWorkSourceState(this.config.projectRoot, bookId);
      const chapter = await this._resyncChapterArtifactsLocked(bookId, chapterNumber, options);
      const audit = await this.reviewChapter(bookId, chapter.chapterNumber);
      await syncWorkSourceArtifacts({projectRoot:this.config.projectRoot,workId:bookId,accept:true,
        acceptPaths:await changedWorkSourcePaths(this.config.projectRoot,bookId,sourceBefore)});
      return { chapter, audit };
    } finally {
      await releaseLock();
    }
  }

  private async _writeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<ChapterPipelineResult> {
    const bookDir = this.state.bookDir(bookId);
    const previousRun = await ChapterCheckpoint.latestForBook(this.config.projectRoot, bookId);
    if (!this.config.allowIncompleteRewrite && previousRun && previousRun.latestRecord("persisted")?.status !== "completed") {
      throw Object.assign(new Error(`Chapter ${previousRun.chapter} has an incomplete operation; use write resume first`), {
        code: "CHAPTER_RESUME_REQUIRED", chapterNumber: previousRun.chapter,
      });
    }
    if (!await this.state.isCompleteBookDirectory(bookDir)) {
      throw Object.assign(new Error(`Work "${bookId}" is not ready for chapter writing. Complete or recover its foundation first.`), {
        code: "WORK_NOT_READY", workId: bookId, recoveryAction: "revise_foundation",
      });
    }
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const paddedChapter = String(chapterNumber).padStart(4, "0");
    const sourceBefore = await captureWorkSourceState(this.config.projectRoot, bookId);
    const result = await this._executeNextChapterLocked(
      bookId,
      wordCount,
      temperatureOverride,
      externalContext,
      undefined,
      async () => {
        const chapterFile = (await readdir(join(bookDir, "chapters")))
          .find((file) => file.startsWith(`${paddedChapter}_`) && file.endsWith(".md"));
        if (!chapterFile) throw new Error(`Chapter ${chapterNumber} completed without a persisted chapter artifact.`);
        await syncWorkSourceArtifacts({projectRoot:this.config.projectRoot,workId:bookId,accept:true,
          acceptPaths:await changedWorkSourcePaths(this.config.projectRoot,bookId,sourceBefore)});
      },
    );
    return result;
  }

  private async _executeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
    recovery?: { readonly checkpoint: ChapterCheckpoint; readonly chapterNumber: number; readonly chapterPersisted: boolean },
    finalize?: () => Promise<void>,
  ): Promise<ChapterPipelineResult> {
    this.throwIfOperationAborted();
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = recovery?.chapterNumber ?? await this.state.getNextChapterNumber(bookId);
    const checkpoint = recovery?.checkpoint ?? new ChapterCheckpoint(this.config.projectRoot, bookId, chapterNumber);
    if (!recovery) {
      await checkpoint.record("started", "completed", { wordCount, temperatureOverride, externalContext });
      await checkpoint.record("baseline", "completed", {
        runtimeSnapshot: await loadRuntimeStateSnapshot(bookDir),
        authorityHashes: chapterAuthorityHashes(await captureWorkSourceState(this.config.projectRoot, bookId), chapterNumber),
        bookIdentity: chapterBookIdentity(book),
      });
    }
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
    const savedInput = recovery ? checkpoint.completed("prepared", PreparedCheckpointSchema) : undefined;
    if (savedInput && (savedInput.chapterMemo.chapter !== chapterNumber || savedInput.contextPackage.chapter !== chapterNumber)) {
      throw new Error("Prepared checkpoint belongs to a different chapter");
    }
    const writeInput = savedInput ? { ...savedInput, contextTrace: undefined } : await this.prepareWriteInput(
      book, bookDir, chapterNumber, externalContext, checkpoint, Boolean(recovery),
    );
    if (!savedInput) await checkpoint.record("prepared", "completed", writeInput);
    const reducedControlInput = {
      chapterIntent: writeInput.chapterIntent,
      chapterMemo: writeInput.chapterMemo,
      chapterIntentData: writeInput.chapterIntentData,
      contextPackage: writeInput.contextPackage,
    };
    const pipelineLang = book.language;
    const lengthSpec = buildLengthSpec(
      wordCount ?? book.chapterWordCount,
      pipelineLang,
      book,
    );
    // 1. Write chapter
    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
    const savedDraft = recovery ? checkpoint.completed("draft", DraftCheckpointSchema) : undefined;
    if (savedDraft && savedDraft.output.chapterNumber !== chapterNumber) throw new Error("Draft checkpoint belongs to a different chapter");
    const output = savedDraft?.output ?? await checkpoint.runStage("draft", () => writer.writeChapterDraft({
      book,
      bookDir,
      chapterNumber,
      ...writeInput,
      lengthSpec,
      ...(wordCount ? { wordCountOverride: wordCount } : {}),
      ...(temperatureOverride ? { temperatureOverride } : {}),
    }), Boolean(recovery));
    this.throwIfOperationAborted();
    const writerCount = countChapterLength(output.content, lengthSpec.countingMode);
    // Preserve the paid draft before any further model or validation call can fail.
    const draftVersion = savedDraft ? savedDraft.draftVersion : book.writing?.reviewMode !== "manual"
      ? await archiveChapterVersion(bookDir, chapterNumber, output.content, "agent") : undefined;
    if (!savedDraft) await checkpoint.record("draft", "completed", { output, draftVersion });

    // Token usage accumulator
    const previousUsage = recovery ? checkpoint.latestCumulativeUsage() : undefined;
    let totalUsage: TokenUsageSummary = previousUsage ?? output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const reviewSkill = book.writing?.reviewMode === "manual" ? undefined :
      (await loadAvailableAgentSkills({ projectRoot: this.config.projectRoot })).skills.filter((skill) => skill.id === "inkos-story-review").at(-1);
    const reviewAgentContext = (agent: "auditor" | "reviser"): AgentContext => {
      const context = this.agentCtxFor(agent, bookId);
      return { ...context, activatedSkills: mergeActivatedSkillGuidance(reviewSkill ? [{ skill: reviewSkill, resources: [] }] : [], context.activatedSkills ?? []) };
    };
    this.logStage(stageLanguage, { zh: "生成章节审查观察", en: "collecting chapter review observations" });
    const savedReview = recovery ? checkpoint.completed("audit", AuditCheckpointSchema) : undefined;
    if (savedReview && savedReview.content !== output.content) throw new Error("Audit checkpoint does not match the saved draft");
    const reviewResult = savedReview ?? await checkpoint.runStage("audit", () => reviewChapterDraft({
      book: { genre: book.genre, language: book.language, narrativeLanguage: resolveNarrativeLanguage(book) },
      bookDir,
      chapterNumber,
      output,
      controlInput: reducedControlInput,
      lengthSpec,
      initialUsage: totalUsage,
      auditor: new ContinuityAuditor(reviewAgentContext("auditor")),
      assertNotEmpty: (content) => this.assertChapterContentNotEmpty(content, chapterNumber, "draft generation"),
      addUsage: PipelineRunner.addUsage,
      disableRetries: book.writing?.reviewMode !== "manual",
      // A rejected citation is a correctable modelling error: allow one
      // correction turn so a single blank or off-by-one sourceRef cannot
      // silently degrade the whole chapter to "audit unavailable".
      maxResultTurns: 2,
    }), Boolean(recovery));
    if (!savedReview) await checkpoint.record("audit", reviewResult.review.unavailable || reviewResult.review.observations.some(item => item.assessment === "unavailable")
      ? "failed" : "completed", reviewResult);
    if (recovery && (reviewResult.review.unavailable || reviewResult.review.observations.some(item => item.assessment === "unavailable"))) {
      throw Object.assign(new Error("Chapter audit remains unavailable; run resume again after addressing the cause"), { code: "CHAPTER_RESUME_AUDIT_UNAVAILABLE" });
    }
    if (!savedReview || !previousUsage) totalUsage = reviewResult.totalUsage;
    let finalContent = reviewResult.content;
    let finalWordCount = reviewResult.wordCount;
    let auditResult = reviewResult.review;
    const findings = reviewFindings(reviewResult.review.observations);
    const actionable = actionableFindings(reviewResult.review.observations);
    const auditUnavailable = reviewResult.review.unavailable || reviewResult.review.observations.some((observation) => observation.assessment === "unavailable");
    const savedCandidateRecord = recovery ? checkpoint.latestRecordAfter("revision-candidate", "revision-started") : undefined;
    const savedCandidate = savedCandidateRecord?.status === "candidate" ? RevisionCandidateCheckpointSchema.parse(savedCandidateRecord.data) : undefined;
    if (savedCandidate && await readChapterVersion(bookDir, chapterNumber, savedCandidate.candidateVersionId) !== savedCandidate.content) {
      throw new Error("Revision candidate differs from its saved version");
    }
    let candidateContent: string | undefined = savedCandidate?.content;
    let candidateVersionId: string | undefined = savedCandidate?.candidateVersionId;
    const preserveCandidate = async (content: string) => {
      const previousCandidate = candidateContent;
      candidateContent = content;
      if (content.trim() && content !== output.content && (!candidateVersionId || previousCandidate !== content)) {
        candidateVersionId = (await archiveChapterVersion(bookDir, chapterNumber, content, "revision")).id;
        await checkpoint.record("revision-candidate", "candidate", { content, candidateVersionId });
      }
    };
    let candidateReview: AuditResult | undefined;
    let pendingRevisionContext: ContextPackage | undefined;
    let autoRevision: AutoRevisionOutcome = {
      status: "skipped",
      reason: book.writing?.reviewMode === "manual" ? "manual-mode" : auditUnavailable ? "audit-unavailable" : "no-actionable-findings",
      findings,
      initialReview: { summary: reviewResult.review.summary, observations: [...reviewResult.review.observations],
        ...(reviewResult.review.unavailable === undefined ? {} : { unavailable: reviewResult.review.unavailable }) },
      ...(draftVersion ? { originalVersionId: draftVersion.id } : {}),
      usage: { ...(reviewResult.review.tokenUsage ? { auditor: reviewResult.review.tokenUsage } : {}) },
    };
    const savedRevision = recovery ? checkpoint.completedAfter("revision", "audit", RevisionCheckpointSchema) : undefined;
    if (savedRevision) {
      if (savedRevision.autoRevision.status === "applied" && (!savedRevision.pendingRevisionContext
        || savedRevision.candidateContent !== savedRevision.finalContent)) throw new Error("Revision checkpoint is incomplete");
      autoRevision = savedRevision.autoRevision;
      finalContent = savedRevision.finalContent;
      candidateContent = savedRevision.candidateContent;
      candidateVersionId = savedRevision.candidateVersionId;
      pendingRevisionContext = savedRevision.pendingRevisionContext;
      if (!previousUsage) totalUsage = savedRevision.totalUsage;
    } else if (book.writing?.reviewMode !== "manual" && !auditUnavailable && actionable.length > 0) {
      this.logStage(stageLanguage, { zh: "根据审稿意见修订草稿", en: "revising draft from review findings" });
      let activeStage: "reviser" | "postAudit" = "reviser";
      try {
        const [rules, storyFrame] = await Promise.all([
          readFile(join(bookDir, "story", "book_rules.md"), "utf-8"), readStoryFrame(bookDir),
        ]);
        const revisionContext: ContextPackage = {
          ...reducedControlInput.contextPackage,
          selectedContext: [
            ...reducedControlInput.contextPackage.selectedContext,
            { source: "story/book_rules.md", reason: "Authoritative book rules", excerpt: rules, protection: "protected" },
            { source: "story/outline/story_frame.md", reason: "Authoritative story foundation", excerpt: storyFrame, protection: "protected" },
            { source: "chapter/intent", reason: "Chapter intent and memo", excerpt: JSON.stringify({ intent: writeInput.chapterIntent, memo: writeInput.chapterMemo, intentData: writeInput.chapterIntentData }), protection: "protected" },
            ...(externalContext?.trim() ? [{ source: "chapter/user-instruction", reason: "Direct user instruction for this chapter", excerpt: externalContext, protection: "protected" as const }] : []),
          ],
        };
        pendingRevisionContext = revisionContext;
        const reviser = new ReviserAgent(reviewAgentContext("reviser"));
        const revised = await checkpoint.runStage("revision", () => reviser.reviseChapter(bookDir, output.content, chapterNumber, findings.map((finding) => finding.observation),
          revisionModeFor(actionable), book.genre, {
            language: book.language, narrativeLanguage: resolveNarrativeLanguage(book), chapterTitle: output.title,
            contextPackage: revisionContext, lengthSpec, autoFindings: findings,
            auditContext: { summary: reviewResult.review.summary, observations: reviewResult.review.observations.filter((observation) => observation.category === "execution" || observation.assessment === "unavailable") },
            onCandidate: preserveCandidate,
          }), Boolean(recovery));
        this.throwIfOperationAborted();
        await preserveCandidate(revised.revisedContent);
        candidateContent = revised.revisedContent;
        totalUsage = PipelineRunner.addUsage(totalUsage, revised.tokenUsage);
        autoRevision = { ...autoRevision, status: "candidate", reason: "awaiting-state-validation", ...(revised.findingDispositions ? { dispositions: [...revised.findingDispositions] } : {}),
          usage: { ...autoRevision.usage, ...(revised.tokenUsage ? { reviser: revised.tokenUsage } : {}) } };
        if (candidateContent === output.content) {
          autoRevision = { ...autoRevision, status: "unchanged", reason: "unchanged" };
        } else {
          // Reaching the Reviser means its complete returned version becomes the
          // manuscript candidate. The follow-up auditor is editorial annotation,
          // not a veto; technical truth validation remains the safety boundary.
          finalContent = candidateContent;
          autoRevision = { ...autoRevision, status: "applied", reason: "accepted-by-reviser; awaiting-technical-validation" };
        }
      } catch (error) {
        this.throwIfOperationAborted();
        if (isChapterResumeSafetyError(error)) throw error;
        const failedUsage = usageFromError(error);
        totalUsage = PipelineRunner.addUsage(totalUsage, failedUsage);
        autoRevision = { ...autoRevision, status: candidateContent?.trim() && candidateContent !== output.content ? "candidate" : "unavailable", reason: `revision-or-review-unavailable: ${String(error)}`,
          ...(failedUsage ? { usage: { ...autoRevision.usage, [activeStage]: failedUsage } } : {}) };
      }
    }

    if (!savedRevision) await checkpoint.record("revision", autoRevision.status === "unavailable" || autoRevision.status === "candidate"
      ? "failed" : autoRevision.status === "skipped" ? "skipped" : "completed",
    { autoRevision, finalContent, candidateContent, candidateVersionId, pendingRevisionContext, totalUsage });
    if (recovery && (autoRevision.status === "unavailable" || autoRevision.status === "candidate")) {
      throw Object.assign(new Error("Chapter revision remains incomplete; the candidate and findings were preserved"), { code: "CHAPTER_RESUME_REVISION_UNAVAILABLE" });
    }
    this.throwIfOperationAborted();
    // 4. Save the final chapter and truth files from a single persistence source
    this.logStage(stageLanguage, { zh: "落盘最终章节", en: "persisting final chapter" });
    this.logStage(stageLanguage, { zh: "生成最终真相文件", en: "rebuilding final truth files" });
    const chapterIndexBeforePersist = await this.state.loadChapterIndex(bookId);
    // 4.1 Validate settler output before writing
    this.logStage(stageLanguage, { zh: "校验真相文件变更", en: "validating truth file updates" });
    const storyDir = join(bookDir, "story");
    const savedBaseline = recovery ? checkpoint.completed("baseline", BaselineCheckpointSchema) : undefined;
    if (recovery && !savedBaseline) throw new Error("Chapter checkpoint has no baseline");
    const [runtimeSnapshot, authorityStoryFrame, authorityBookRules] = await Promise.all([
      savedBaseline ? Promise.resolve(savedBaseline.runtimeSnapshot) : loadRuntimeStateSnapshot(bookDir),
      readStoryFrame(bookDir),
      readFile(join(storyDir, "book_rules.md"), "utf-8"),
    ]);
    const stateLanguage = resolveNarrativeLanguage(book);
    const oldState = renderCurrentStateProjection(runtimeSnapshot.currentState, stateLanguage);
    const oldHooks = renderHooksProjection(runtimeSnapshot.hooks, stateLanguage);
    const authorityChapterSummaries = renderChapterSummariesProjection(runtimeSnapshot.chapterSummaries, stateLanguage);
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    const prepareAndValidate = async (content: string, candidate: boolean) => {
      const savedSettlement = recovery ? checkpoint.completedMatching("settlement", SettlementCheckpointSchema,
        item => item.content === content && item.candidate === candidate && item.persistenceOutput.content === content
          && item.persistenceOutput.chapterNumber === chapterNumber) : undefined;
      const persistenceOutput = savedSettlement?.persistenceOutput ?? await checkpoint.runStage("settlement", () =>
        this.buildPersistenceOutput(bookId, book, bookDir, chapterNumber, output,
          content, lengthSpec.countingMode, reducedControlInput, candidate, recovery?.chapterPersisted ? chapterNumber - 1 : undefined), Boolean(recovery));
      const draftUsage = output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const persistenceUsage = persistenceOutput.tokenUsage ?? draftUsage;
      if (!savedSettlement) totalUsage = PipelineRunner.addUsage(totalUsage, {
        promptTokens: Math.max(0, persistenceUsage.promptTokens - draftUsage.promptTokens),
        completionTokens: Math.max(0, persistenceUsage.completionTokens - draftUsage.completionTokens),
        totalTokens: Math.max(0, persistenceUsage.totalTokens - draftUsage.totalTokens),
      });
      if (!savedSettlement) await checkpoint.record("settlement", "completed", { candidate, content, persistenceOutput, totalUsage });
      const validationWriter = candidate ? new WriterAgent({ ...this.agentCtxFor("writer", bookId), disableRetries: true }) : writer;
      const validationAgent = candidate ? new StateValidatorAgent({ ...this.agentCtxFor("state-validator", bookId), disableRetries: true }) : validator;
      const result = await checkpoint.runStage("state-validation", () => validateChapterTruthPersistence({
        writer: validationWriter, validator: validationAgent, book, bookDir, chapterNumber, title: persistenceOutput.title, content, persistenceOutput,
        previousTruth: { oldState, oldHooks },
        authorityContext: { storyFrame: authorityStoryFrame, bookRules: authorityBookRules, chapterSummaries: authorityChapterSummaries },
        reducedControlInput, language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message), logger: this.config.logger,
        allowRecovery: !candidate,
      }), Boolean(recovery));
      await checkpoint.record("state-validation", result.validation.consistent && !result.validation.reconciliationRequired
        ? "completed" : "failed", result);
      return result;
    };
    let truthValidation: Awaited<ReturnType<typeof prepareAndValidate>>;
    const savedTruth = recovery ? checkpoint.completedMatching("state-validation", TruthCheckpointSchema,
      item => item.persistenceOutput.chapterNumber === chapterNumber && item.persistenceOutput.content === finalContent
        && item.persistenceOutput.runtimeStateApplied && item.validation.consistent && !item.validation.reconciliationRequired) : undefined;
    try {
      if (savedTruth) {
        truthValidation = savedTruth;
      } else truthValidation = await prepareAndValidate(finalContent, autoRevision.status === "applied");
      this.throwIfOperationAborted();
      if (autoRevision.status === "applied" && (!truthValidation.validation.consistent || truthValidation.validation.reconciliationRequired)) {
        throw new Error("Revised chapter failed state validation");
      }
    } catch (error) {
      this.throwIfOperationAborted();
      if (isChapterResumeSafetyError(error)) throw error;
      if (recovery) throw error;
      if (autoRevision.status !== "applied") throw error;
      autoRevision = { ...autoRevision, status: "candidate", reason: `technical-validation-failed: ${String(error)}` };
      finalContent = output.content;
      truthValidation = await prepareAndValidate(finalContent, false);
      this.throwIfOperationAborted();
    }
    if (recovery && (!truthValidation.validation.consistent || truthValidation.validation.reconciliationRequired)) {
      throw Object.assign(new Error("Chapter state validation remains incomplete"), { code: "CHAPTER_RESUME_STATE_UNAVAILABLE" });
    }
    const savedPostAudit = recovery && savedTruth
      ? checkpoint.completedAfterAll("post-audit", ["audit", "revision", "state-validation"], PostAuditCheckpointSchema) : undefined;
    if (savedPostAudit && savedPostAudit.content !== finalContent) throw new Error("Post-audit checkpoint does not match the revision");
    if (savedPostAudit) {
      autoRevision = savedPostAudit.autoRevision;
      candidateReview = savedPostAudit.candidateReview;
      auditResult = savedPostAudit.auditResult;
      if (!previousUsage) totalUsage = savedPostAudit.totalUsage;
    } else if ((autoRevision.status === "applied" || autoRevision.status === "unchanged") && pendingRevisionContext) {
      try {
        this.logStage(stageLanguage, { zh: "复核修订稿并保留审稿意见", en: "adding auditor notes to revised draft" });
        const settledContext: ContextPackage = {
          ...pendingRevisionContext,
          selectedContext: [
            ...pendingRevisionContext.selectedContext,
            { source: "runtime/settled-state", reason: "Canon settled from the accepted Reviser text", excerpt: truthValidation.persistenceOutput.updatedState, protection: "protected" },
            { source: "runtime/settled-hooks", reason: "Hooks settled from the accepted Reviser text", excerpt: truthValidation.persistenceOutput.updatedHooks, protection: "protected" },
            { source: "runtime/chapter-summaries", reason: "Chapter summaries settled from the accepted Reviser text", excerpt: truthValidation.persistenceOutput.updatedChapterSummaries, protection: "protected" },
          ],
        };
        const comparison = await checkpoint.runStage("post-audit", () => new ContinuityAuditor(reviewAgentContext("auditor")).compareRevision({
          chapterNumber, original: output.content, candidate: finalContent, findings,
          language: book.language, narrativeLanguage: resolveNarrativeLanguage(book), contextPackage: settledContext,
        }), Boolean(recovery));
        this.throwIfOperationAborted();
        totalUsage = PipelineRunner.addUsage(totalUsage, comparison.tokenUsage);
        autoRevision = { ...autoRevision, assessments: [...comparison.assessments], newIssues: [...comparison.newIssues],
          ...(comparison.warnings?.length ? { postAuditWarnings: [...comparison.warnings] } : {}),
          reason: comparison.warnings?.length ? "revised-text-accepted; post-audit-needs-review" : "revised-text-accepted; post-audit-notes-attached",
          usage: { ...autoRevision.usage, postAudit: comparison.tokenUsage } };
        const assessments = new Map(comparison.assessments.map((item) => [item.findingId, item]));
        const retainedObservations = reviewResult.review.observations.flatMap((observation, index) => {
          if (observation.category === "execution" || observation.assessment === "unavailable") return [observation];
          const assessment = assessments.get(`finding-${index + 1}`);
          if (!assessment) return [observation];
          return [{ ...observation,
            assessment: assessment.status === "resolved" ? "resolved" as const : observation.assessment === "issue" ? "issue" as const : "observation" as const,
            summary: `${observation.summary} ${assessment.explanation}`,
            evidence: [assessment.evidence],
            sourceRefs: [{ sourceId: `chapter-${chapterNumber}`, quote: assessment.evidence }],
          }];
        });
        candidateReview = {
          ...reviewResult.review,
          observations: [...retainedObservations, ...comparison.newIssues, ...(comparison.warnings ?? []).map(warning => ({
            code: warning.code, summary: `Неподтверждённое замечание повторного аудита${warning.findingId ? ` (${warning.findingId})` : ""}: ${warning.message}`,
            assessment: "unavailable" as const, category: "quality" as const, evidence: [],
          }))],
          summary: resolveNarrativeLanguage(book) === "ru"
            ? "Текст Ревизора принят. Ниже сохранены заметки повторного аудита для вычитки."
            : book.language === "en" ? "Reviser text accepted. Follow-up auditor notes are retained for proofreading."
              : "修订文本已采纳，后续审查意见已保留供校对。",
        };
      } catch (error) {
        this.throwIfOperationAborted();
        if (isChapterResumeSafetyError(error)) throw error;
        const failedUsage = usageFromError(error);
        totalUsage = PipelineRunner.addUsage(totalUsage, failedUsage);
        autoRevision = { ...autoRevision, reason: "revised-text-accepted; post-audit-unavailable", ...(failedUsage ? { usage: { ...autoRevision.usage, postAudit: failedUsage } } : {}) };
        candidateReview = {
          ...reviewResult.review,
          observations: [...reviewResult.review.observations, {
            code: "POST_REVISION_AUDIT_UNAVAILABLE",
            summary: resolveNarrativeLanguage(book) === "ru" ? `Повторный аудит не завершился: ${String(error)}` : `Follow-up audit did not complete: ${String(error)}`,
            assessment: "unavailable",
            category: "quality",
            evidence: [],
          }],
          summary: resolveNarrativeLanguage(book) === "ru" ? "Текст Ревизора принят; повторный аудит недоступен." : "Reviser text accepted; follow-up audit unavailable.",
        };
      }
    }
    if ((autoRevision.status === "applied" || autoRevision.status === "unchanged") && candidateReview) auditResult = candidateReview;
    if (!savedPostAudit) await checkpoint.record("post-audit", candidateReview ? "completed" : "skipped", { autoRevision, candidateReview, auditResult, totalUsage, content: finalContent });
    if (autoRevision.status === "applied" && !draftVersion) {
      const version = await archiveChapterVersion(bookDir, chapterNumber, output.content, "agent");
      autoRevision = { ...autoRevision, originalVersionId: version.id };
    }
    if (autoRevision.status !== "applied" && candidateVersionId) autoRevision = { ...autoRevision, candidateVersionId };
    const persistenceOutput = truthValidation.persistenceOutput;
    finalWordCount = persistenceOutput.wordCount;
    const lengthTelemetry = this.buildLengthTelemetry({
      lengthSpec, writerCount, postReviseCount: autoRevision.status === "applied" ? finalWordCount : 0,
      finalCount: finalWordCount, repairApplied: autoRevision.status === "applied",
    });
    if (!truthValidation.validation.consistent || truthValidation.validation.reconciliationRequired) {
      auditResult = {
        ...auditResult,
        observations: [
          ...auditResult.observations,
          ...(truthValidation.validation.observations.length > 0
            ? truthValidation.validation.observations
            : [unresolvedStateObservation(stateLanguage)]),
        ],
      };
    }

    await persistChapterArtifacts({
      chapterNumber,
      chapterTitle: persistenceOutput.title,
      auditResult,
      finalWordCount,
      lengthTelemetry,
      tokenUsage: totalUsage,
      autoRevision,
      loadChapterIndex: () => this.state.loadChapterIndex(bookId),
      saveChapter: (index) => writer.saveChapter(bookDir, persistenceOutput, pipelineLang, index, resolveNarrativeLanguage(book)),
      markBookActiveIfNeeded: () => this.markBookActiveIfNeeded(bookId),
    });
    const pipelineIncomplete = auditUnavailable || autoRevision.status === "unavailable"
      || autoRevision.status === "candidate"
      || !truthValidation.validation.consistent || truthValidation.validation.reconciliationRequired;
    const persistedCheckpoint = { chapterNumber, title: persistenceOutput.title, content: persistenceOutput.content,
      autoRevision, auditResult, finalWordCount, lengthTelemetry, totalUsage };
    // A saved chapter is not complete until its Work artifact revisions are synchronized.
    await checkpoint.record("persisted", "incomplete", persistedCheckpoint);
    await finalize?.();
    if (!pipelineIncomplete) await checkpoint.record("persisted", "completed", persistedCheckpoint);
    else {
      const incompleteStages = [
        ...(auditUnavailable ? ["audit"] : []),
        ...(autoRevision.status === "unavailable" || autoRevision.status === "candidate" ? ["revision"] : []),
        ...(autoRevision.reason.includes("post-audit-unavailable") ? ["post-audit"] : []),
        ...(!truthValidation.validation.consistent || truthValidation.validation.reconciliationRequired ? ["state-validation"] : []),
      ];
      throw Object.assign(new Error(`Chapter ${chapterNumber} was saved, but its pipeline is incomplete (${incompleteStages.join(", ")}); use write resume`), {
        code: "CHAPTER_RESUME_REQUIRED", chapterNumber, incompleteStages,
      });
    }

    // 6. Send notification
    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      const chapterLength = formatLengthCount(finalWordCount, lengthSpec.countingMode);
      await dispatchNotification(this.config.notifyChannels, {
        title: `${book.title} 第${chapterNumber}章`,
        body: [
          `**${persistenceOutput.title}** | ${chapterLength}`,
          auditResult.summary,
          ...auditResult.observations.map((observation) => `- ${observation.code}: ${observation.summary}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    await this.emitWebhook("pipeline-complete", bookId, chapterNumber, {
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      observationCount: auditResult.observations.length,
    });

    return {
      chapterNumber,
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      review: auditResult,
      autoRevision,
      lengthTelemetry,
      ...(chapterLengthDelivery(finalWordCount,lengthSpec)?{delivery:chapterLengthDelivery(finalWordCount,lengthSpec)}:{}),
      tokenUsage: totalUsage,
      ...(writeInput.contextTrace ? { contextTrace: writeInput.contextTrace } : {}),
    };
  }

  private async _resyncChapterArtifactsLocked(
    bookId: string,
    chapterNumber?: number,
    options: { readonly allowNewHooks?: boolean } = {},
  ): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to sync.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }

    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest persisted chapter can be synced safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "根据已编辑正文同步真相文件与索引", en: "syncing truth files and indexes from edited chapter body" });
    const pipelineLang = book.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const baselineChapter = targetChapter - 1;
    const baselineSnapshot = await loadRuntimeStateSnapshotAtChapter({
      bookDir,
      chapterNumber: baselineChapter,
      language: pipelineLang,
    }).catch((error) => {
      throw new Error(
        `Cannot sync chapter ${targetChapter} safely: baseline snapshot ${baselineChapter} is unavailable (${String(error)})`,
      );
    });
    const stateLanguage = resolveNarrativeLanguage(book);
    const oldState = renderCurrentStateProjection(baselineSnapshot.currentState, stateLanguage);
    const oldHooks = renderHooksProjection(baselineSnapshot.hooks, stateLanguage);
    const [authorityStoryFrame, authorityBookRules] = await Promise.all([
      readStoryFrame(bookDir), readFile(join(bookDir, "story", "book_rules.md"), "utf-8"),
    ]);
    const authorityContext = {storyFrame:authorityStoryFrame,bookRules:authorityBookRules,
      chapterSummaries:renderChapterSummariesProjection(baselineSnapshot.chapterSummaries,stateLanguage)};

    const reducedControlInput = await this.prepareExistingChapterContext(book,targetChapter,
      this.config.externalContext ?? (pipelineLang==='en'?`Reconstruct facts from existing chapter ${targetChapter}, preserving its prose.`:`根据现有第${targetChapter}章重建事实，保持正文。`));

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let syncedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      baselineChapter,
      allowNewHooks: options.allowNewHooks,
      title: targetMeta.title,
      content,
      chapterIntent: reducedControlInput.chapterIntent,
      contextPackage: reducedControlInput.contextPackage,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      syncedOutput.updatedState,
      oldHooks,
      syncedOutput.updatedHooks,
      pipelineLang,
      authorityContext,
      stateLanguage,
    );

    if (!validation.consistent) {
      const recovery = await reconcileChapterStateAfterReview({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        baselineChapter,
        allowNewHooks: options.allowNewHooks,
        title: targetMeta.title,
        content,
        reducedControlInput: {
          chapterIntent: reducedControlInput.chapterIntent,
          contextPackage: reducedControlInput.contextPackage,
        },
        oldState,
        oldHooks,
        originalValidation: validation,
        authorityContext,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "reconciled") {
        throw new Error(
          recovery.observations[0]?.summary
            ?? `Chapter sync still failed for chapter ${targetChapter}.`,
        );
      }
      syncedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.consistent) {
      throw new Error(`Chapter sync still failed for chapter ${targetChapter}.`);
    }

    index[targetIndex] = {
      ...targetMeta,
      wordCount: syncedOutput.wordCount,
      ...(targetMeta.lengthTelemetry ? { lengthTelemetry: {
        ...targetMeta.lengthTelemetry,
        countingMode: resolveLengthCountingMode(book.language, book.narrativeLanguage),
        finalCount: syncedOutput.wordCount,
      } } : {}),
      updatedAt: new Date().toISOString(),
      observations: targetMeta.observations.filter((observation) => observation.code !== "state-sync-required"),
    };
    await writer.saveChapter(bookDir, syncedOutput, pipelineLang, index, resolveNarrativeLanguage(book));
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: syncedOutput.wordCount,
      review: {
        observations: [],
        summary: "chapter truth/state resynced from edited body",
      },
      lengthTelemetry: index[targetIndex]!.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Import operations (style imitation + canon for spinoff)
  // ---------------------------------------------------------------------------

  async generateStyleGuide(bookId: string, referenceText: string, sourceName?: string): Promise<string> {
    const sample = referenceText.trim();
    if (!sample) throw new Error("Reference text is required for style extraction.");

    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    const book = await this.state.loadBookConfig(bookId);
    const language = book.language;
    const guide = await compileStyleGuide({
      client: this.config.client,
      model: this.config.model,
      projectRoot: this.config.projectRoot,
      workId: bookId,
      referenceText: sample,
      sourceName,
      language,
      activeSkills: this.currentActivatedSkills("style-guide"),
      signal: this.currentAbortSignal(),
    });
    await syncWorkSourceArtifacts({projectRoot:this.config.projectRoot,workId:bookId,accept:true,
      writes:[{relativePath:join("works",bookId,"source/story/style_guide.md"),content:guide}]});
    return guide;
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Projects the parent's current truth files into parent_canon.md without
   * asking an LLM to reinterpret facts the host already owns.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    const source=await readPinnedParentCanon(this.config.projectRoot,targetBookId,parentBookId);
    const target=await loadWorkManifest(this.config.projectRoot,targetBookId);
    await syncWorkSourceArtifacts({
      projectRoot:this.config.projectRoot,workId:targetBookId,accept:true,status:target.status,lineage:source.lineage,
      writes:[
        {relativePath:join("works",targetBookId,"source/story/parent_canon.md"),content:source.canon},
        ...(source.styleGuide?.trim()?[{relativePath:join("works",targetBookId,"source/story/style_guide.md"),content:source.styleGuide}]:[]),
      ],
    });
    return source.canon;
  }

  // ---------------------------------------------------------------------------
  // Chapter import (for continuation writing from existing chapters)
  // ---------------------------------------------------------------------------

  /**
   * Import existing chapters into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   *
   * Step 1: Generate foundation (story_frame, volume_map, book_rules) from all chapters.
   * Step 2: Sequentially replay each chapter through ChapterAnalyzer to build truth files.
   */
  async importChapters(input: ImportChaptersInput): Promise<ImportChaptersResult> {
    this.throwIfOperationAborted();
    const emptyChapterNumbers = input.chapters.flatMap((chapter, index) => chapter.content.trim() ? [] : [index + 1]);
    if (!input.chapters.length || emptyChapterNumbers.length) {
      throw Object.assign(new Error(`Import requires manuscript text in every source chapter. Empty source chapters: ${JSON.stringify(emptyChapterNumbers)}.`), {
        code: 'CHAPTER_IMPORT_EMPTY_CONTENT', emptyChapterNumbers,
      });
    }
    const releaseLock = await this.state.acquireBookLock(input.bookId);
    try {
      const sourceBefore = await captureWorkSourceState(this.config.projectRoot, input.bookId);
      const book = await this.state.loadBookConfig(input.bookId);
      const bookDir = this.state.bookDir(input.bookId);
      const resolvedLanguage = book.language;

      const startFrom = input.resumeFrom ?? 1;
      const directionPath=join(bookDir,'story','import-direction.md');
      let continuationInstruction=input.continuationInstruction?.trim();
      if(continuationInstruction){
        await mkdir(join(bookDir,'story'),{recursive:true});
        await writeFile(directionPath,continuationInstruction+'\n','utf8');
      }else{
        try{continuationInstruction=(await readFile(directionPath,'utf8')).trim();}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }

      const log = this.config.logger?.child("import");

      // Step 1: Generate foundation once. A failed replay preserves the draft
      // foundation, so retry can resume without paying for Architect again.
      const foundationReady = await this.state.isCompleteBookDirectory(bookDir);
      if (startFrom === 1 && !foundationReady) {
        log?.info(this.localize(resolvedLanguage, {
          zh: `步骤 1：从 ${input.chapters.length} 章生成基础设定...`,
          en: `Step 1: Generating foundation from ${input.chapters.length} chapters...`,
        }));
        const importContext = await compileImportSource({
          client: this.config.client,
          model: this.config.model,
          projectRoot: this.config.projectRoot,
          workId: input.bookId,
          chapters: input.chapters,
          language: resolvedLanguage,
          activeSkills: this.currentActivatedSkills("import-context"),
          signal: this.currentAbortSignal(),
        });
        const foundationSource = importContext.markdown;
        if (importContext.compiled) {
          const runtimeDir = join(bookDir, "story", "runtime");
          await mkdir(runtimeDir, { recursive: true });
          await writeFile(join(runtimeDir, "import-context-trace.json"), JSON.stringify({
            mode: "semantic-compilation",
            sourceChapters: input.chapters.length,
            chunkCount: importContext.chunkCount,
          }, null, 2), "utf-8");
        }

        const architect = new ArchitectAgent(this.agentCtxFor("architect", input.bookId));
        const isSeries = input.importMode === "series";
        const foundation = await architect.generateFoundationFromImport(
          book,
          foundationSource,
          continuationInstruction,
          undefined,
          { importMode: isSeries ? "series" : "continuation" },
        );
        this.throwIfOperationAborted();
        await architect.writeFoundationFiles(
          bookDir,
          foundation,
          resolvedLanguage,
          "init",
          resolveNarrativeLanguage(book),
        );
        await this.resetImportReplayTruthFiles(bookDir, resolvedLanguage, resolveNarrativeLanguage(book));
        await this.state.saveChapterIndex(input.bookId, [], { allowEmptyWithChapterFiles: true });
        await this.state.snapshotState(input.bookId, 0);

        log?.info(this.localize(resolvedLanguage, {
          zh: "基础设定已生成。",
          en: "Foundation generated.",
        }));
      } else if (startFrom === 1) {
        log?.info(this.localize(resolvedLanguage, {
          zh: "复用已保存的基础设定候选。",
          en: "Reusing the preserved foundation candidate.",
        }));
      }

      // Step 2: Sequential replay
      log?.info(this.localize(resolvedLanguage, {
        zh: `步骤 2：从第 ${startFrom} 章开始顺序回放...`,
        en: `Step 2: Sequential replay from chapter ${startFrom}...`,
      }));
      const writer = new WriterAgent(this.agentCtxFor("writer", input.bookId));
      const countingMode = resolveLengthCountingMode(book.language, book.narrativeLanguage);
      let totalWords = 0;
      let importedCount = 0;

      for (let i = startFrom - 1; i < input.chapters.length; i++) {
        this.throwIfOperationAborted();
        const ch = input.chapters[i]!;
        const chapterNumber = i + 1;
        const chapterIntent=resolvedLanguage==='en'
          ? `Reconstruct the established facts and unresolved threads of imported chapter ${chapterNumber}. Preserve the supplied source text.`
          : `重建导入的第${chapterNumber}章已发生的事实和未解决线索，保留输入原文。`;
        const {contextPackage}=await this.prepareExistingChapterContext(book,chapterNumber,chapterIntent);

        log?.info(this.localize(resolvedLanguage, {
          zh: `分析章节 ${chapterNumber}/${input.chapters.length}：${ch.title}...`,
          en: `Analyzing chapter ${chapterNumber}/${input.chapters.length}: ${ch.title}...`,
        }));

        // Analyze chapter to get truth file updates
        const output = await writer.settleChapterState({
          book,
          bookDir,
          chapterNumber,
          baselineChapter:chapterNumber-1,
          content: ch.content,
          title: ch.title,
          chapterIntent,
          contextPackage,
        });
        this.throwIfOperationAborted();

        const chapterWordCount = countChapterLength(ch.content, countingMode);
        const persistedOutput: WriteChapterOutput = {
          ...output,
          content: ch.content,
          wordCount: chapterWordCount,
        };

        const existingIndex = await this.state.loadChapterIndex(input.bookId);
        const now = new Date().toISOString();
        const newEntry: ChapterMeta = {
          number: chapterNumber,
          title: output.title,
          wordCount: chapterWordCount,
          createdAt: now,
          updatedAt: now,
          observations: [],
          provenance: "imported",
        };
        // Replace if exists (resume case), otherwise append
        const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
        const updatedIndex = existingIdx >= 0
          ? existingIndex.map((e, idx) => idx === existingIdx ? newEntry : e)
          : [...existingIndex, newEntry];
        await writer.saveChapter(bookDir, persistedOutput, resolvedLanguage, updatedIndex, resolveNarrativeLanguage(book));

        importedCount++;
        totalWords += chapterWordCount;
      }

      if (input.chapters.length > 0) {
        await this.markBookActiveIfNeeded(input.bookId);
      }

      const nextChapter = input.chapters.length + 1;
      log?.info(this.localize(resolvedLanguage, {
        zh: `完成。已导入 ${importedCount} 章，共 ${formatLengthCount(totalWords, countingMode)}。下一章：${nextChapter}`,
        en: `Done. ${importedCount} chapters imported, ${formatLengthCount(totalWords, countingMode)}. Next chapter: ${nextChapter}`,
      }));

      // A resumed import also completes the preserved foundation and earlier
      // chapters named by this import, even when their bytes need no rewrite.
      const importPaths = [...(await captureWorkSourceState(this.config.projectRoot,input.bookId)).keys()].filter(path => {
        if (path === "source/book.json" || path === "source/chapters/index.json" || path.startsWith("source/story/")) return true;
        const chapter = /^source\/chapters\/(\d+)(?:_|\.)/.exec(path);
        return chapter !== null && Number(chapter[1]) >= 1 && Number(chapter[1]) <= input.chapters.length;
      });
      await syncWorkSourceArtifacts({projectRoot:this.config.projectRoot,workId:input.bookId,accept:true,
        acceptPaths:[...importPaths,...await changedWorkSourcePaths(this.config.projectRoot,input.bookId,sourceBefore)]});

      return {
        bookId: input.bookId,
        importedCount,
        totalWords,
        nextChapter,
      };
    } finally {
      await releaseLock();
    }
  }

  private static addUsage(
    a: TokenUsageSummary,
    b?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number },
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  private async buildPersistenceOutput(
    bookId: string,
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    output: WriteChapterDraftOutput,
    finalContent: string,
    countingMode: Parameters<typeof countChapterLength>[1],
    reducedControlInput: {
      chapterIntent: string;
      contextPackage: ContextPackage;
    },
    disableRetries = false,
    baselineChapter?: number,
  ): Promise<WriteChapterOutput> {
    const writer = new WriterAgent({ ...this.agentCtxFor("writer", bookId), disableRetries });
    const analyzed = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber,
      ...(baselineChapter === undefined ? {} : { baselineChapter, allowReapply: true }),
      content: finalContent,
      title: output.title,
      chapterIntent: reducedControlInput.chapterIntent,
      contextPackage: reducedControlInput.contextPackage,
    });

    return {
      ...analyzed,
      content: finalContent,
      wordCount: countChapterLength(finalContent, countingMode),
      tokenUsage: PipelineRunner.addUsage(output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, analyzed.tokenUsage),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    checkpoint?: ChapterCheckpoint,
    reuseCheckpoint = false,
  ): Promise<Pick<WriteChapterInput, "externalContext" | "chapterIntent" | "chapterMemo" | "chapterIntentData" | "contextPackage"> & {
    readonly contextTrace?: ChapterContextTraceSummary;
  }> {
    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      externalContext,
      { reuseExistingIntentWhenContextMissing: true, checkpoint, reuseCheckpoint },
    );

    return {
      externalContext,
      chapterIntent: plan.intentMarkdown,
      chapterMemo: plan.memo,
      chapterIntentData: plan.intent,
      contextPackage: composed.contextPackage,
      contextTrace: {
        tracePath: relativeToBookDir(bookDir, composed.tracePath),
        selectedSources: [...composed.trace.selectedSources],
        protectedSources: [...composed.trace.contextTiers.protectedSources],
        compressibleSources: [...composed.trace.contextTiers.compressibleSources],
        tokenBudget: { ...composed.trace.tokenBudget },
        ...(composed.trace.retrieval ? {
          retrieval: {
            ...composed.trace.retrieval,
            candidates: composed.trace.retrieval.candidates.map((candidate) => ({ ...candidate })),
            ...(composed.trace.retrieval.semanticSelectedIds
              ? { semanticSelectedIds: [...composed.trace.retrieval.semanticSelectedIds] }
              : {}),
          },
        } : {}),
        ...(composed.trace.compression ? {
          compression: {
            ...composed.trace.compression,
            protectedSources: [...composed.trace.compression.protectedSources],
            compressedSources: [...composed.trace.compression.compressedSources],
          },
        } : {}),
      },
    };
  }

  private async resetImportReplayTruthFiles(
    bookDir: string,
    language: LengthLanguage,
    projectionLanguage: NarrativeLanguage,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        this.buildImportReplayStateSeed(language),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        this.buildImportReplayHooksSeed(language),
        "utf-8",
      ),
      rm(join(storyDir, "chapter_summaries.md"), { force: true }),
      rm(join(storyDir, "volume_summaries.md"), { force: true }),
      rm(join(storyDir, "memory.db"), { force: true }),
      rm(join(storyDir, "memory.db-shm"), { force: true }),
      rm(join(storyDir, "memory.db-wal"), { force: true }),
      rm(join(storyDir, "state"), { recursive: true, force: true }),
      rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
    ]);
    await createInitialRuntimeState({ bookDir, language, projectionLanguage, hooks: [] });
  }

  private buildImportReplayStateSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 0 |",
        "| Current Location | (not set) |",
        "| Protagonist State | (not set) |",
        "| Current Goal | (not set) |",
        "| Current Constraint | (not set) |",
        "| Current Alliances | (not set) |",
        "| Current Conflict | (not set) |",
        "",
      ].join("\n");
    }

    return [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 0 |",
      "| 当前位置 | （未设定） |",
      "| 主角状态 | （未设定） |",
      "| 当前目标 | （未设定） |",
      "| 当前限制 | （未设定） |",
      "| 当前敌我 | （未设定） |",
      "| 当前冲突 | （未设定） |",
      "",
    ].join("\n");
  }

  private buildImportReplayHooksSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
    }

    return [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  private assertChapterContentNotEmpty(content: string, chapterNumber: number, stage: string): void {
    if (content.trim().length > 0) return;
    throw new Error(`Chapter ${chapterNumber} has empty chapter content after ${stage}`);
  }

  private buildLengthTelemetry(params: {
    lengthSpec: LengthSpec;
    writerCount: number;
    postReviseCount: number;
    finalCount: number;
    repairApplied: boolean;
  }): LengthTelemetry {
    return {
      target: params.lengthSpec.target,
      countingMode: params.lengthSpec.countingMode,
      writerCount: params.writerCount,
      postReviseCount: params.postReviseCount,
      finalCount: params.finalCount,
      repairApplied: params.repairApplied,
    };
  }

  private async collectReviewObservations(params: {
    auditor: ContinuityAuditor;
    book: BookConfig;
    bookDir: string;
    chapterContent: string;
    chapterNumber: number;
    language: LengthLanguage;
    auditOptions: {
      temperature?: number;
      contextPackage: ContextPackage;
    };
  }): Promise<AuditResult> {
    const contextPackage = await this.withPreviousChapterContext(
      params.bookDir,
      params.chapterNumber,
      params.auditOptions.contextPackage,
    );
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      params.chapterContent,
      params.chapterNumber,
      params.book.genre,
      {
        language: params.language,
        narrativeLanguage: resolveNarrativeLanguage(params.book),
        contextPackage,
        ...(params.auditOptions.temperature === undefined ? {} : { temperature: params.auditOptions.temperature }),
      },
    );
    return {
      ...llmAudit,
      observations: llmAudit.observations,
      summary: llmAudit.summary,
      tokenUsage: llmAudit.tokenUsage,
    };
  }

  private async withPreviousChapterContext(
    bookDir: string,
    chapterNumber: number,
    contextPackage: ContextPackage,
  ): Promise<ContextPackage> {
    if (chapterNumber <= 1) return contextPackage;
    const previousContent = await this.readChapterContent(bookDir, chapterNumber - 1);
    return {
      ...contextPackage,
      selectedContext: [
        ...contextPackage.selectedContext,
        {
          source: `runtime/previous_chapter#${chapterNumber - 1}`,
          reason: "Previous chapter text required for transition review.",
          excerpt: previousContent,
          protection: "protected",
        },
      ],
    };
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private async prepareExistingChapterContext(book:BookConfig,chapterNumber:number,chapterIntent:string) {
    const contextPackage=await new ComposerAgent(this.agentCtxFor('composer',book.id)).selectTaskContext({
      bookDir:this.state.bookDir(book.id),chapterNumber,goal:chapterIntent,language:book.language,
    });
    const rules=await readFile(join(this.state.bookDir(book.id),'story/book_rules.md'),'utf8');
    return {chapterIntent,contextPackage:{...contextPackage,selectedContext:[...contextPackage.selectedContext,
      {source:'story/book_rules.md',reason:'Author constraints for the existing chapter.',excerpt:rules,protection:'protected' as const},
    ]}};
  }

  private async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
      readonly checkpoint?: ChapterCheckpoint;
      readonly reuseCheckpoint?: boolean;
    },
  ): Promise<{
    plan: PlanChapterOutput;
    composed: ComposeChapterOutput;
  }> {
    const savedPlan = options?.reuseCheckpoint ? options.checkpoint?.completed("plan", PlanCheckpointSchema) : undefined;
    if (savedPlan && (savedPlan.intent.chapter !== chapterNumber || savedPlan.memo.chapter !== chapterNumber)) throw new Error("Plan checkpoint belongs to a different chapter");
    const plan = savedPlan ?? (options?.checkpoint
      ? await options.checkpoint.runStage("plan", () => this.resolveGovernedPlan(book, bookDir, chapterNumber, externalContext, options), Boolean(options.reuseCheckpoint))
      : await this.resolveGovernedPlan(book, bookDir, chapterNumber, externalContext, options));
    if (!savedPlan) await options?.checkpoint?.record("plan", "completed", plan);
    const composerCtx = this.agentCtxFor("composer", book.id);
    const composer = new ComposerAgent(composerCtx);
    const savedContext = options?.reuseCheckpoint ? options.checkpoint?.completed("context", ContextCheckpointSchema) : undefined;
    if (savedContext && (savedContext.contextPackage.chapter !== chapterNumber || savedContext.trace.chapter !== chapterNumber)) throw new Error("Context checkpoint belongs to a different chapter");
    const compose = () => composer.composeChapter({
      book,
      bookDir,
      chapterNumber,
      plan,
      referenceContextProvider: (request) => selectBookReferenceContext(
        this.config.projectRoot,
        book.id,
        request,
        (selectionRequest) => composer.selectReferenceSections(selectionRequest),
      ),
      onContextCompression: this.config.onContextCompression,
    });
    const composed = savedContext ?? (options?.checkpoint
      ? await options.checkpoint.runStage("context", compose, Boolean(options.reuseCheckpoint)) : await compose());
    if (!savedContext) await options?.checkpoint?.record("context", "completed", composed);

    return { plan, composed };
  }

  private async resolveGovernedPlan(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<PlanChapterOutput> {
    if (
      options?.reuseExistingIntentWhenContextMissing &&
      (!externalContext || externalContext.trim().length === 0)
    ) {
      const persisted = await loadPersistedPlan(bookDir, chapterNumber);
      if (persisted) return persisted;
    }

    const planner = new PlannerAgent(this.agentCtxFor("planner", book.id));
    const plan = await planner.planChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext,
    });
    // Persist in the new memo format so subsequent compose/write phases can
    // skip the planner LLM call when no new context is supplied.
    await savePersistedPlan(bookDir, plan);
    return plan;
  }

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    chapterNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      chapterNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async readChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const files = await readdir(chaptersDir);
    const paddedNum = String(chapterNumber).padStart(4, "0");
    const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found in ${chaptersDir}`);
    }
    const raw = await readFile(join(chaptersDir, chapterFile), "utf-8");
    return chapterDocumentBody(raw, chapterNumber, "");
  }
}
