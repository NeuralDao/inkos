import { Command } from "commander";
import {
  ComposerAgent,
  ContextPackageSchema,
  ContinuityAuditor,
  DEFAULT_REVISE_MODE,
  buildLengthSpec,
  loadAvailableAgentSkills,
  loadPersistedPlan,
  loadRuntimeStateSnapshotAtChapter,
  mergeActivatedSkillGuidance,
  PlannerAgent,
  ReviserAgent,
  resolveNarrativeLanguage,
  renderCurrentStateProjection,
  renderChapterSummariesProjection,
  renderHooksProjection,
  savePersistedPlan,
  selectBookReferenceContext,
  syncWorkSourceArtifacts,
  StateManager,
  StateValidatorAgent,
  WriterAgent,
  ObservationSchema,
  PipelineRunner,
  type Observation,
  type ReviseMode,
} from "@actalk/inkos-core";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveCliProfileSkills, resolveBookId } from "../utils.js";

type IsolatedRole = "planner" | "composer" | "author" | "writer" | "auditor" | "reviser" | "settler" | "state-validator";

const CONTEXT_PACKAGE_SCHEMA_VERSION = 1;

function chapterId(chapter: number): string {
  return String(chapter).padStart(4, "0");
}

function contextPackagePath(bookDir: string, chapter: number): string {
  return join(bookDir, "story", "runtime", `chapter-${chapterId(chapter)}.context-package.json`);
}

async function readContextPackage(bookDir: string, chapter: number) {
  const path = contextPackagePath(bookDir, chapter);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No composed context for chapter ${chapter}. Run "inkos agent run composer --book <book-id> --chapter ${chapter}" first.`);
    }
    throw error;
  }
  const envelope = parsed as { version?: unknown; contextPackage?: unknown };
  if (envelope.version !== CONTEXT_PACKAGE_SCHEMA_VERSION) throw new Error(`Unsupported context package version in ${path}`);
  return ContextPackageSchema.parse(envelope.contextPackage);
}

async function readChapterText(bookDir: string, chapter: number, inputFile?: string): Promise<string> {
  if (inputFile) return readFile(resolve(inputFile), "utf-8");
  const files = await readdir(join(bookDir, "chapters"));
  const prefix = chapterId(chapter);
  const file = files.find((name) => name.startsWith(prefix) && name.endsWith(".md"));
  if (!file) throw new Error(`Chapter ${chapter} does not exist yet; provide --input-file for an uncommitted draft.`);
  return readFile(join(bookDir, "chapters", file), "utf-8");
}

function chapterTitleAndBody(source: string, chapter: number, narrativeLanguage: "en" | "ru" | "zh") {
  const lines = source.split(/\r?\n/);
  const heading = lines.find((line) => line.startsWith("# "))?.slice(2).trim();
  const title = heading?.replace(/^(?:Глава|Chapter)\s+\d+\s*[:.]?\s*/i, "").trim() || `Chapter ${chapter}`;
  const headingPattern = narrativeLanguage === "ru" ? /^#\s*Глава\s+\d+\s*[:.]?/i :
    narrativeLanguage === "zh" ? /^#\s*第\s*\d+\s*章/ : /^#\s*Chapter\s+\d+\s*[:.]?/i;
  const bodyStart = lines.findIndex((line) => headingPattern.test(line.trim()));
  const body = bodyStart < 0 ? source : lines.slice(bodyStart + 1).join("\n").replace(/^\s*\n/, "");
  return { title, body };
}

async function saveRunArtifact(projectRoot: string, bookId: string, chapter: number, role: IsolatedRole, extension: "json" | "md", value: unknown): Promise<string> {
  const dir = join(projectRoot, ".inkos", "agent-runs", encodeURIComponent(bookId), `chapter-${chapterId(chapter)}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${role}-${randomUUID().slice(0, 8)}.${extension}`);
  const content = extension === "json" ? `${JSON.stringify(value, null, 2)}\n` : String(value);
  await writeFile(path, content, "utf-8");
  return path;
}

function parseObservations(value: unknown): ReadonlyArray<Observation> {
  if (!value || typeof value !== "object" || !Array.isArray((value as { observations?: unknown }).observations)) {
    throw new Error("--observations-file must contain an audit JSON object with an observations array.");
  }
  return (value as { observations: unknown[] }).observations.map((item) => ObservationSchema.parse(item));
}

export const agentRunCommand = new Command("run")
  .description("Run one long-form agent stage and stop; outputs are saved as reviewable artifacts")
  .argument("<role>", "planner, composer, author/writer, auditor, reviser, settler, or state-validator")
  .requiredOption("--book-id <book-id>", "Book ID")
  .requiredOption("--chapter <n>", "Chapter number", (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Chapter number must be a positive integer.");
    return parsed;
  })
  .option("--input-file <path>", "Source chapter/draft file for auditor, reviser, settler, or state-validator")
  .option("--observations-file <path>", "Auditor JSON report required by reviser")
  .option("--settlement-file <path>", "Settler JSON result required by state-validator")
  .option("--stage-context <text>", "One-off planning guidance")
  .option("--mode <mode>", "Revision mode: polish, rewrite, rework, anti-detect, or spot-fix", DEFAULT_REVISE_MODE)
  .option("--words <n>", "Target prose length for author")
  .option("--result-json", "Print result JSON")
  .action(async (roleArg: string, opts) => {
    const role = (roleArg === "writer" ? "author" : roleArg) as IsolatedRole;
    const supported: ReadonlyArray<IsolatedRole> = ["planner", "composer", "author", "auditor", "reviser", "settler", "state-validator"];

    let releaseBookLock: (() => void) | undefined;
    try {
      if (!supported.includes(role)) throw new Error(`Unsupported isolated role "${roleArg}". Supported roles: ${supported.join(", ")}.`);
      const root = findProjectRoot();
      const bookId = await resolveBookId(opts.bookId, root);
      const state = new StateManager(root);
      releaseBookLock = await state.acquireBookLock(bookId);
      const book = await state.loadBookConfig(bookId);
      const bookDir = state.bookDir(bookId);
      const chapter = opts.chapter as number;
      const config = await loadConfig({ projectRoot: root });
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, { externalContext: opts.stageContext }));
      const profileSkills = await resolveCliProfileSkills(root, "longform-novel");
      const availableSkills = await loadAvailableAgentSkills({ projectRoot: root });
      const reviewSkill = availableSkills.skills.filter((skill) => skill.id === "inkos-story-review").at(-1);
      const skills = role === "auditor" || role === "reviser"
        ? mergeActivatedSkillGuidance(reviewSkill ? [{ skill: reviewSkill, resources: [] }] : [], profileSkills)
        : profileSkills;
      const roleContext = pipeline.createAgentContext(role === "author" ? "writer" : role, bookId);
      const writerContext = role === "settler" && !config.modelOverrides?.settler
        ? pipeline.createAgentContext("writer", bookId)
        : undefined;
      const agentContext = {
        ...roleContext,
        ...(writerContext ? { model: writerContext.model, client: writerContext.client } : {}),
        activatedSkills: skills,
      };
      const narrativeLanguage = resolveNarrativeLanguage(book);
      let result: unknown;
      let artifactPath: string | undefined;

      if (role === "planner") {
        const planner = new PlannerAgent(agentContext);
        const plan = await planner.planChapter({ book, bookDir, chapterNumber: chapter, externalContext: opts.stageContext });
        await savePersistedPlan(bookDir, plan);
        await syncWorkSourceArtifacts({
          projectRoot: root,
          workId: bookId,
          accept: true,
          acceptPaths: [
            `source/story/runtime/chapter-${chapterId(chapter)}.plan.json`,
            `source/story/runtime/chapter-${chapterId(chapter)}.intent.md`,
          ],
        });
        result = plan;
        artifactPath = await saveRunArtifact(root, bookId, chapter, role, "json", plan);
      } else if (role === "composer") {
        const plan = await loadPersistedPlan(bookDir, chapter);
        if (!plan) throw new Error(`No persisted plan for chapter ${chapter}. Run the planner first.`);
        const composer = new ComposerAgent(agentContext);
        const composed = await composer.composeChapter({
          book,
          bookDir,
          chapterNumber: chapter,
          plan,
          referenceContextProvider: (request) => selectBookReferenceContext(
            root,
            bookId,
            request,
            (selectionRequest) => composer.selectReferenceSections(selectionRequest),
          ),
        });
        const packagePath = contextPackagePath(bookDir, chapter);
        await writeFile(packagePath, `${JSON.stringify({ version: CONTEXT_PACKAGE_SCHEMA_VERSION, contextPackage: composed.contextPackage }, null, 2)}\n`, "utf-8");
        await syncWorkSourceArtifacts({
          projectRoot: root,
          workId: bookId,
          accept: true,
          acceptPaths: [
            `source/story/runtime/chapter-${chapterId(chapter)}.context.json`,
            `source/story/runtime/chapter-${chapterId(chapter)}.trace.json`,
            `source/story/runtime/chapter-${chapterId(chapter)}.context-package.json`,
          ],
        });
        result = { chapter, selectedSources: composed.trace.selectedSources, contextPath: composed.contextPath, tracePath: composed.tracePath, contextPackagePath: packagePath };
        artifactPath = await saveRunArtifact(root, bookId, chapter, role, "json", result);
      } else if (role === "author") {
        const plan = await loadPersistedPlan(bookDir, chapter);
        if (!plan) throw new Error(`No persisted plan for chapter ${chapter}. Run the planner first.`);
        const contextPackage = await readContextPackage(bookDir, chapter);
        const requestedWords = opts.words ? Number(opts.words) : book.chapterWordCount;
        if (!Number.isInteger(requestedWords) || requestedWords < 1) throw new Error("--words must be a positive integer.");
        const lengthSpec = buildLengthSpec(requestedWords, book.language, book);
        const writer = new WriterAgent(agentContext);
        const draft = await writer.writeChapterDraft({
          book, bookDir, chapterNumber: chapter,
          chapterIntent: plan.intentMarkdown,
          chapterMemo: plan.memo,
          chapterIntentData: plan.intent,
          contextPackage,
          lengthSpec,
          wordCountOverride: requestedWords,
        });
        const document = `# ${narrativeLanguage === "ru" ? `Глава ${chapter}: ${draft.title}` : narrativeLanguage === "zh" ? `第${chapter}章 ${draft.title}` : `Chapter ${chapter}: ${draft.title}`}\n\n${draft.content.trim()}\n`;
        artifactPath = await saveRunArtifact(root, bookId, chapter, role, "md", document);
        result = { ...draft, content: undefined, artifactPath };
      } else if (role === "auditor") {
        const contextPackage = await readContextPackage(bookDir, chapter);
        const source = await readChapterText(bookDir, chapter, opts.inputFile);
        const { body } = chapterTitleAndBody(source, chapter, narrativeLanguage);
        const auditor = new ContinuityAuditor(agentContext);
        result = await auditor.auditChapter(bookDir, body, chapter, book.genre, {
          language: book.language,
          narrativeLanguage,
          contextPackage,
        });
        artifactPath = await saveRunArtifact(root, bookId, chapter, role, "json", result);
      } else if (role === "reviser") {
        if (!opts.observationsFile) throw new Error("Reviser requires --observations-file from a prior auditor run.");
        const contextPackage = await readContextPackage(bookDir, chapter);
        const source = await readChapterText(bookDir, chapter, opts.inputFile);
        const { body, title } = chapterTitleAndBody(source, chapter, narrativeLanguage);
        const audit = JSON.parse(await readFile(resolve(opts.observationsFile), "utf-8"));
        const observations = parseObservations(audit);
        const mode = opts.mode as ReviseMode;
        if (!["polish", "rewrite", "rework", "anti-detect", "spot-fix"].includes(mode)) throw new Error(`Unsupported revision mode "${mode}".`);
        const reviser = new ReviserAgent(agentContext);
        const revised = await reviser.reviseChapter(bookDir, body, chapter, observations, mode, book.genre, {
          language: book.language,
          narrativeLanguage,
          chapterTitle: title,
          contextPackage,
          lengthSpec: buildLengthSpec(book.chapterWordCount, book.language, book),
        });
        const document = `# ${narrativeLanguage === "ru" ? `Глава ${chapter}: ${title}` : narrativeLanguage === "zh" ? `第${chapter}章 ${title}` : `Chapter ${chapter}: ${title}`}\n\n${revised.revisedContent.trim()}\n`;
        artifactPath = await saveRunArtifact(root, bookId, chapter, role, "md", document);
        result = { ...revised, revisedContent: undefined, artifactPath };
      } else if (role === "settler") {
        const plan = await loadPersistedPlan(bookDir, chapter);
        if (!plan) throw new Error(`No persisted plan for chapter ${chapter}. Run the planner first.`);
        const contextPackage = await readContextPackage(bookDir, chapter);
        const source = await readChapterText(bookDir, chapter, opts.inputFile);
        const { body, title } = chapterTitleAndBody(source, chapter, narrativeLanguage);
        const settler = new WriterAgent(agentContext);
        result = await settler.settleChapterState({
          book, bookDir, chapterNumber: chapter, baselineChapter: chapter - 1, title, content: body,
          chapterIntent: plan.intentMarkdown, contextPackage,
        });
        artifactPath = await saveRunArtifact(root, bookId, chapter, role, "json", result);
      } else {
        if (!opts.settlementFile) throw new Error("State validator requires --settlement-file from a prior settler run.");
        const source = await readChapterText(bookDir, chapter, opts.inputFile);
        const { body } = chapterTitleAndBody(source, chapter, narrativeLanguage);
        const settlement = JSON.parse(await readFile(resolve(opts.settlementFile), "utf-8")) as {
          updatedState?: string; updatedHooks?: string;
        };
        if (typeof settlement.updatedState !== "string" || typeof settlement.updatedHooks !== "string") {
          throw new Error("Settlement file must contain updatedState and updatedHooks strings.");
        }
        const baseline = await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber: chapter - 1, language: book.language });
        const validator = new StateValidatorAgent(agentContext);
        const [storyFrame, bookRules] = await Promise.all([
          readFile(join(bookDir, "story", "outline", "story_frame.md"), "utf-8"),
          readFile(join(bookDir, "story", "book_rules.md"), "utf-8"),
        ]);
        result = await validator.validate(
          body, chapter,
          renderCurrentStateProjection(baseline.currentState, book.language),
          settlement.updatedState,
          renderHooksProjection(baseline.hooks, book.language),
          settlement.updatedHooks,
          book.language,
          {
            storyFrame,
            bookRules,
            chapterSummaries: renderChapterSummariesProjection(baseline.chapterSummaries, book.language),
          },
        );
        artifactPath = await saveRunArtifact(root, bookId, chapter, role, "json", result);
      }

      const output = { role, bookId, chapter, result, artifactPath };
      if (opts.resultJson) log(JSON.stringify(output, null, 2));
      else log(`${role} finished for chapter ${chapter}. Artifact: ${artifactPath}`);
    } catch (error) {
      if (opts.resultJson) log(JSON.stringify({ error: String(error) }));
      else logError(`Isolated agent run failed: ${error}`);
      process.exitCode = 1;
    } finally {
      releaseBookLock?.();
    }
  });
