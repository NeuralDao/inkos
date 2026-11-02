import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";
import { ObservationSchema } from "./observation.js";

const UsageSchema = z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).strict();
export const AutoRevisionOutcomeSchema = z.object({
  status: z.enum(["skipped", "applied", "candidate", "unchanged", "unavailable"]),
  reason: z.string(),
  findings: z.array(z.object({ id: z.string(), observation: ObservationSchema }).strict()),
  initialReview: z.object({ summary: z.string(), observations: z.array(ObservationSchema), unavailable: z.boolean().optional() }).strict().optional(),
  dispositions: z.array(z.object({ findingId: z.string(), status: z.enum(["addressed", "not_addressed", "rejected"]), explanation: z.string() }).strict()).optional(),
  assessments: z.array(z.object({ findingId: z.string(), status: z.enum(["resolved", "remaining"]), explanation: z.string(), evidence: z.string() }).strict()).optional(),
  newIssues: z.array(ObservationSchema).optional(),
  candidateVersionId: z.string().optional(),
  originalVersionId: z.string().optional(),
  usage: z.object({ auditor: UsageSchema.optional(), reviser: UsageSchema.optional(), postAudit: UsageSchema.optional() }).strict().optional(),
}).strict();
export type AutoRevisionOutcome = z.infer<typeof AutoRevisionOutcomeSchema>;

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  wordCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  observations: z.array(ObservationSchema),
  provenance: z.enum(["generated", "imported", "edited"]),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    totalTokens: z.number().int(),
  }).strict().optional(),
  autoRevision: AutoRevisionOutcomeSchema.optional(),
}).strict();

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;
