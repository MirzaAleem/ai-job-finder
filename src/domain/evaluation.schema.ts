import { z } from 'zod';

export const RecommendationSchema = z.enum(['HIGH_PRIORITY', 'APPLY', 'CONSIDER', 'SKIP']);
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const ProviderKindSchema = z.enum(['LOCAL', 'CLOUD']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const EscalationReasonSchema = z.enum([
  'LOW_CONFIDENCE',
  'MALFORMED_RESPONSE',
  'MISSING_FIELDS',
  'AMBIGUOUS_REQUIREMENTS',
  'CONFLICTING_REQUIREMENTS',
  'UNCLEAR_SENIORITY',
  'UNCLEAR_EXPERIENCE',
  'UNCLEAR_SALARY',
  'UNUSUAL_DESCRIPTION',
  'MODEL_REQUESTED',
]);
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

export const ESCALATION_REASON_LABELS: Record<EscalationReason, string> = {
  LOW_CONFIDENCE: 'low confidence',
  MALFORMED_RESPONSE: 'malformed local response',
  MISSING_FIELDS: 'missing required fields',
  AMBIGUOUS_REQUIREMENTS: 'ambiguous requirements',
  CONFLICTING_REQUIREMENTS: 'conflicting requirements',
  UNCLEAR_SENIORITY: 'unclear seniority',
  UNCLEAR_EXPERIENCE: 'ambiguous experience requirement',
  UNCLEAR_SALARY: 'unclear salary requirement',
  UNUSUAL_DESCRIPTION: 'unusual job description',
  MODEL_REQUESTED: 'model requested escalation',
};

/**
 * Exactly what an LLM is asked to return. Kept deliberately flat and small:
 * every extra field is tokens spent on every job, on every run.
 */
export const LLMEvaluationSchema = z.object({
  jobId: z.string().optional(),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  recommendation: RecommendationSchema,
  matchingSkills: z.array(z.string()).default([]),
  missingSkills: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  needsCloud: z.boolean().default(false),
  escalationReason: z.string().nullable().default(null),
  /** Set by the model when a specific dimension could not be determined. */
  uncertainties: z
    .object({
      seniority: z.boolean().default(false),
      experience: z.boolean().default(false),
      salary: z.boolean().default(false),
      requirements: z.boolean().default(false),
      conflicting: z.boolean().default(false),
    })
    .default({
      seniority: false,
      experience: false,
      salary: false,
      requirements: false,
      conflicting: false,
    }),
});
export type LLMEvaluation = z.infer<typeof LLMEvaluationSchema>;

/** Batch form: the model returns one entry per job it was given. */
export const LLMBatchEvaluationSchema = z.object({
  evaluations: z.array(LLMEvaluationSchema.extend({ jobId: z.string() })),
});

/** A settled evaluation, after any escalation, ready to persist. */
export interface FinalEvaluation extends LLMEvaluation {
  jobId: string;
  providerUsed: ProviderKind;
  localEvaluation: LLMEvaluation | null;
  cloudEvaluation: LLMEvaluation | null;
  escalated: boolean;
  escalationReasons: EscalationReason[];
  /** True when escalation was warranted but unavailable (disabled or failed). */
  degraded: boolean;
  provider: string;
  /** The model whose verdict won — the cloud model after an escalation. */
  model: string;
  /**
   * The local model that evaluated this job, regardless of who won.
   *
   * This, not `model`, is the cache key: the question the cache answers is
   * "has this local model already judged this content?", and an escalated job
   * must still be cached or it re-pays for the cloud on every run.
   */
  localModel: string;
  contentHash: string;
  fromCache: boolean;
}
