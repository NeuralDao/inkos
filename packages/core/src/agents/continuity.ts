import { BaseAgent } from "./base.js";
import type { ContextPackage } from "../models/input-governance.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";
import { numberReviewSource, type Observation } from "../models/observation.js";
import {loadWorkManifest} from '../harness/work-store.js';
import {readArtifactRevision} from '../harness/artifact-reader.js';
import {currentExecutionBaselineWork} from '../harness/execution-evidence.js';
import {chapterDocumentBody} from '../utils/chapter-document.js';
import {changedSourceRegion} from '../utils/source-text.js';
import type { NarrativeLanguage } from "../utils/book-language.js";
import { Type } from "@sinclair/typebox";
import type { RevisionFinding, FindingAssessment } from "../pipeline/auto-revision-policy.js";

const RevisionComparisonSchema = Type.Object({
  assessments: Type.Array(Type.Object({
    findingId: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("resolved"), Type.Literal("remaining")]),
    explanation: Type.String({ minLength: 1 }),
    evidence: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
  newIssues: Type.Array(Type.Object({
    code: Type.String({ minLength: 1 }),
    summary: Type.String({ minLength: 1 }),
    scope: Type.Union([Type.Literal("local"), Type.Literal("structural"), Type.Literal("unknown")]),
    evidence: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export interface AuditResult {
  readonly observations: ReadonlyArray<Observation>;
  readonly summary: string;
  readonly unavailable?: boolean;
  readonly reviewedArtifact?: {workId:string;artifactId:string;revisionId:string};
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class ContinuityAuditor extends BaseAgent {
  get name(): string {
    return "continuity-auditor";
  }

  async compareRevision(input: {
    readonly chapterNumber: number;
    readonly original: string;
    readonly candidate: string;
    readonly findings: ReadonlyArray<RevisionFinding>;
    readonly language: "zh" | "en";
    readonly narrativeLanguage?: NarrativeLanguage;
    readonly contextPackage: ContextPackage;
  }): Promise<{ readonly assessments: ReadonlyArray<FindingAssessment & { explanation: string; evidence: string }>;
    readonly newIssues: ReadonlyArray<Observation>; readonly tokenUsage: NonNullable<AuditResult["tokenUsage"]> }> {
    const context = renderNarrativeSelectedContext(input.contextPackage.selectedContext, input.language);
    const sourceId = `chapter-${input.chapterNumber}`;
    const messages = [
      { role: "system" as const, content: `Compare the original chapter and revision under the activated review Skill and governed context. Assess each supplied finding ID exactly once as resolved or remaining. Report newly introduced defects and any worsening of an existing finding separately as new issues, including conflicts with the author's instructions, canon or narrative voice. Evidence must be an exact nonempty quote from the revised chapter. Preserve the author's instructions and canon. ${input.narrativeLanguage === "ru" ? "Write explanations and summaries in Russian; retain IDs and schema values." : ""}` },
      { role: "user" as const, content: JSON.stringify({ chapterNumber: input.chapterNumber, governedContext: context, original: input.original, candidate: input.candidate, findings: input.findings }) },
    ];
    const { result, usage } = await this.submitStructured(messages, {
      name: "submit_revision_comparison", label: "Compare chapter revision",
      description: "Assess every original finding and identify newly introduced issues with exact revised-chapter evidence.",
      parameters: RevisionComparisonSchema,
      validate: (value) => {
        const expected = new Set(input.findings.map((finding) => finding.id));
        const seen = new Set<string>();
        for (const assessment of value.assessments) {
          if (!expected.has(assessment.findingId) || seen.has(assessment.findingId) || !input.candidate.includes(assessment.evidence)) throw new Error("Invalid finding assessment or evidence");
          seen.add(assessment.findingId);
        }
        if (seen.size !== expected.size || value.newIssues.some((issue) => !input.candidate.includes(issue.evidence))) throw new Error("Incomplete comparison or invalid evidence");
        return value;
      },
    }, { temperature: 0, maxTokens: this.ctx.client.defaults.maxTokens, disableRetries: true });
    return {
      assessments: result.assessments,
      newIssues: result.newIssues.map((issue) => ({
        code: issue.code, summary: issue.summary, scope: issue.scope,
        assessment: "issue" as const, category: "quality" as const,
        evidence: [issue.evidence], sourceRefs: [{ sourceId, quote: issue.evidence }],
      })),
      tokenUsage: usage,
    };
  }

  async auditChapter(
    _bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    _genre: string | undefined,
    options: {
      readonly language: "zh" | "en";
      readonly narrativeLanguage?: NarrativeLanguage;
      readonly contextPackage: ContextPackage;
      readonly temperature?: number;
      readonly disableRetries?: boolean;
    },
  ): Promise<AuditResult> {
    const narrativeLanguage = options.narrativeLanguage ?? options.language;
    const isEnglish = narrativeLanguage === "en";
    const isRussian = narrativeLanguage === "ru";
    const isOperationalEnglish = options.language === "en";
    const systemPrompt = isEnglish
      ? "Audit this chapter against the activated review Skill and supplied governed context. Finish with exactly one submit_chapter_review tool call. Its root-level summary is the overall chapter review; every observations[] item must also have its own nonempty summary explaining that specific finding and its story or reader impact. The root summary never replaces an observation summary. Every observation must include code, summary, assessment, category, scope, and sourceRefs. Use assessment=issue for a defect, observation for a neutral or positive note, resolved only when an explicitly supplied prior finding is verified as fixed, and unavailable only when required evidence is missing. Use category=quality for prose, canon, chronology, causality, and chapter-plan adherence; category=execution only for whether a tool, API, or external operation completed; category=scope only for a verified change outside an explicitly authorized edit region. The scope field means repair breadth only: local, structural, or unknown; use unknown when assessment is not issue. Do not confuse it with category=scope. Cite exact numbered source lines. Do not estimate length; the host computes it. An empty observations array is valid, but the root summary is still required."
      : isRussian
        ? "Audit this chapter against the activated review Skill and supplied governed context. Finish with exactly one submit_chapter_review tool call. Its root-level summary is the overall chapter review; every observations[] item must also have its own nonempty summary explaining that specific finding and its story or reader impact. The root summary never replaces an observation summary. Every observation must include code, summary, assessment, category, scope, and sourceRefs. Use assessment=issue for a defect, observation for a neutral or positive note, resolved only when an explicitly supplied prior finding is verified as fixed, and unavailable only when required evidence is missing. Use category=quality for prose, canon, chronology, causality, and chapter-plan adherence; category=execution only for whether a tool, API, or external operation completed; category=scope only for a verified change outside an explicitly authorized edit region. The scope field means repair breadth only: local, structural, or unknown; use unknown when assessment is not issue. Do not confuse it with category=scope. Cite exact numbered source lines. Do not estimate length; the host computes it. An empty observations array is valid, but the root summary is still required. Write the overall summary and each observation summary in Russian; keep codes, field names, enum values, IDs, and other technical fields unchanged."
        : "按已激活的审稿 Skill 和权威上下文审查本章。最后必须且只能调用一次 submit_chapter_review。根级 summary 是整章总评；每个 observations[] 项必须有独立且非空的 summary，解释该条发现及其对故事或读者的影响，根级 summary 不能代替单条 summary。每条观察都必须包含 code、summary、assessment、category、scope 和 sourceRefs。assessment=issue 表示缺陷，observation 表示中性或正面记录；只有明确提供了既有问题且证据证明已修复时才用 resolved；只有缺少所需证据时才用 unavailable。category=quality 用于文本、设定、时间顺序、因果和章节计划执行问题；category=execution 仅用于工具、API 或外部操作是否完成；category=scope 仅用于有证据证明超出明确授权编辑范围的更改。字段 scope 只表示修订范围：local、structural 或 unknown；assessment 不是 issue 时使用 unknown。不要把它与 category=scope 混淆。引用所给编号原文中的确切行。不估算字数，字数由宿主计算。observations 为空是合法的，但根级 summary 仍然必填。";
    const governedContext = renderNarrativeSelectedContext(
      options.contextPackage.selectedContext,
      options.language,
    );
    const sources = new Map([["governed-context", governedContext], [`chapter-${chapterNumber}`, chapterContent]]);
    const primarySourceId=`chapter-${chapterNumber}`;
    let reviewedArtifact:AuditResult['reviewedArtifact'];
    let comparison:{scope:'episode_start'|'parent_revision';sourceId:string;before:{revisionId:string;checksum:string};after:{revisionId:string;checksum:string};changedRegion:ReturnType<typeof changedSourceRegion>}|undefined;
    if(this.ctx.bookId){
      let work;
      try{work=await loadWorkManifest(this.ctx.projectRoot,this.ctx.bookId);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const prefix=`source/chapters/${String(chapterNumber).padStart(4,'0')}_`;
      const artifact=work?.artifacts.find(a=>a.revisions.some(r=>r.id===a.currentRevisionId&&r.path.startsWith(prefix)&&r.path.endsWith('.md')));
      if(work&&artifact?.currentRevisionId){
        const current=await readArtifactRevision({projectRoot:this.ctx.projectRoot,workId:work.id,artifactId:artifact.id,revisionId:artifact.currentRevisionId});
        const body=(text:string)=>chapterDocumentBody(text,chapterNumber,'',narrativeLanguage);
        // A draft audit must not claim the identity of a different persisted revision.
        if(body(current.bytes.toString('utf8'))===chapterContent){
          reviewedArtifact={workId:work.id,artifactId:artifact.id,revisionId:current.revision.id};
          const baseline=currentExecutionBaselineWork();
          const beforeId=baseline===undefined?current.revision.parentRevisionId:baseline?.id===work.id?baseline.artifacts.find(a=>a.id===artifact.id)?.currentRevisionId:undefined;
          if(beforeId){
            const before=await readArtifactRevision({projectRoot:this.ctx.projectRoot,workId:work.id,artifactId:artifact.id,revisionId:beforeId});
            const beforeText=body(before.bytes.toString('utf8'));
            const sourceId=beforeId===current.revision.id?primarySourceId:`${primarySourceId}@${beforeId}`;
            if(sourceId!==primarySourceId)sources.set(sourceId,beforeText);
            comparison={scope:baseline===undefined?'parent_revision':'episode_start',sourceId,before:{revisionId:beforeId,checksum:before.revision.checksum},after:{revisionId:current.revision.id,checksum:current.revision.checksum},changedRegion:changedSourceRegion(beforeText,chapterContent)};
          }
        }
      }
    }
    const userPrompt = JSON.stringify({ chapterNumber,comparison, sources: [...sources].map(([sourceId, content]) => ({ sourceId, numberedLines: numberReviewSource(content) })) });

    const { result, usage } = await this.submitSourcedReview(
      [
        { role: "system", content: systemPrompt },
        ...(comparison?[{role:'system' as const,content:'Separately check the actual before/current changes against the author-authorized revision region. Classify verified changes outside that region as scope and cite both versions. Classify ordinary content findings as quality and tool/external-operation claims as execution. Missing comparison evidence is unavailable, not a scope violation. A narrow edit request does not narrow a separately requested whole-chapter review.'}]:[]),
        { role: "user", content: userPrompt },
      ],
      sources, {
        name: "submit_chapter_review",
        label: isOperationalEnglish ? "Submit chapter review" : "提交章节审稿",
        description: isOperationalEnglish
          ? "Submit evidence-backed observations only."
          : isRussian
            ? "Submit one structured chapter review. Include a separate nonempty summary for every observation and an overall summary."
            : "只提交有证据的审稿观察。",
      },
      // Reasoning and the structured review share the configured per-agent output budget.
      { temperature: options.temperature ?? 0.3, maxTokens: this.ctx.client.defaults.maxTokens, chapterReview:true, disableRetries: options.disableRetries,
        validateObservations:observations=>{
          for(const observation of observations.filter(item=>item.category==='scope'&&item.assessment==='issue')){
            const ids=new Set(observation.sourceRefs.map(ref=>ref.sourceId));
            if(!comparison||comparison.before.revisionId===comparison.after.revisionId||!ids.has(comparison.sourceId)||!ids.has(primarySourceId))throw Object.assign(new Error('A scope violation requires distinct verified before/current sources and citations to both.'),{code:'REVIEW_SCOPE_EVIDENCE_REQUIRED'});
          }
        },
      },
    );
    return {
      observations: result.observations,
      summary: result.summary,
      tokenUsage: usage,
      ...(reviewedArtifact?{reviewedArtifact}:{}),
    };
  }
}
