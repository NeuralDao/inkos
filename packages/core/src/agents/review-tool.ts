import { Type } from "@sinclair/typebox";

export const ObservationToolSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  assessment: Type.Optional(Type.Union([Type.Literal("issue"), Type.Literal("resolved"), Type.Literal("observation")], { description: "Whether the evidence identifies a defect, verifies a previously identified issue was resolved, or records a neutral observation." })),
  summary: Type.String({ minLength: 1 }),
  evidence: Type.Array(Type.String({ minLength: 1 })),
});

export const SourcedReviewToolSchema = Type.Object({
  summary: Type.String(),
  observations: Type.Array(Type.Object({
    code: Type.String({ minLength: 1 }), summary: Type.String({ minLength: 1 }),
    assessment: Type.Union([Type.Literal("issue"), Type.Literal("resolved"), Type.Literal("observation"), Type.Literal("unavailable")], {description:"Use unavailable when a requested comparison lacks its source or execution evidence; missing evidence is not a content defect."}),
    evidence: Type.Array(Type.String()),
    sourceRefs: Type.Array(Type.Union([
      Type.Object({ sourceId: Type.String(), startLine: Type.Integer({minimum:1}), endLine: Type.Integer({minimum:1}) },
        {additionalProperties:false,description:"Preferred: select a short inclusive line range from the numbered source. The host copies the exact original excerpt."}),
      Type.Object({ sourceId: Type.String(), quote: Type.String({ minLength: 1, description: "Alternative: exact verbatim text from the named source, preserving punctuation." }) }, {additionalProperties:false}),
    ]), { description: "Cite supplied source evidence. May be empty only for an unavailable assessment." }),
  })),
});

export const SourcedReviewIndexToolSchema=Type.Object({
  summary:Type.String(),
  observations:Type.Array(Type.Object({
    code:Type.String({minLength:1}),
    summary:Type.String({minLength:1,description:"Explain this finding concisely using the selected evidence and its effect on the story. The explanation and assessment must describe the same finding."}),
    assessment:SourcedReviewToolSchema.properties.observations.items.properties.assessment,
    category:Type.Optional(Type.Union([Type.Literal("quality"),Type.Literal("execution"),Type.Literal("scope")], { description: "quality: prose, canon, chronology, causality, or chapter-plan adherence; execution: completion of a tool, API, or external operation only; scope: a verified edit outside an authorized edit region." })),
    scope:Type.Optional(Type.Union([Type.Literal("local"),Type.Literal("structural"),Type.Literal("unknown")], {description:"The smallest scope needed to correct this finding."})),
    sourceRefs:Type.Array(Type.Object({sourceId:Type.String(),startLine:Type.Integer({minimum:1}),endLine:Type.Integer({minimum:1})},{additionalProperties:false}),{description:"Select nonempty source line ranges. May be empty only for an unavailable assessment."}),
  },{additionalProperties:false})),
});

/** Long-form chapter reviews use an explicit contract; short-fiction reviews keep the shared, more flexible schema. */
export const ChapterReviewIndexToolSchema=Type.Object({
  summary:Type.String({minLength:1,description:"Required overall assessment of the chapter. This does not replace the summary required on each observation."}),
  observations:Type.Array(Type.Object({
    ...SourcedReviewIndexToolSchema.properties.observations.items.properties,
    summary:Type.String({minLength:1,description:"Required nonempty explanation of this specific finding, its exact evidence, and its effect on the story. The root-level summary does not replace it; the explanation and assessment must describe the same finding."}),
    assessment:Type.Union([Type.Literal("issue"),Type.Literal("resolved"),Type.Literal("observation"),Type.Literal("unavailable")], {description:"Use issue for a defect, observation for a neutral or positive note, resolved only for an explicitly supplied prior finding verified as fixed, and unavailable only when required evidence is missing."}),
    category:Type.Union([Type.Literal("quality"),Type.Literal("execution"),Type.Literal("scope")], { description: "quality: prose, canon, chronology, causality, or chapter-plan adherence; execution: completion of a tool, API, or external operation only; scope: a verified change outside an explicitly authorized edit region." }),
    scope:Type.Union([Type.Literal("local"),Type.Literal("structural"),Type.Literal("unknown")], {description:"Repair scope: the smallest edit breadth needed to correct an issue. Use unknown for non-issue assessments. This is distinct from category='scope'."}),
  },{additionalProperties:false})),
});

export const ArtifactReviewIndexToolSchema = Type.Object({
  ...SourcedReviewIndexToolSchema.properties,
  observations: Type.Array(Type.Object({
    ...SourcedReviewIndexToolSchema.properties.observations.items.properties,
    category: Type.Union([Type.Literal("quality"), Type.Literal("execution"), Type.Literal("scope")], {
      description: "quality: prose, canon, chronology, causality, or chapter-plan adherence. execution: completion of a tool, API, or external operation only; never story events or plan adherence. scope: verified changes outside the author's authorized revision region, citing before/current sources.",
    }),
  }, { additionalProperties: false })),
});
