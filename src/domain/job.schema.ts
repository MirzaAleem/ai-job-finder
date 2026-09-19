import { z } from 'zod';

/**
 * Tri-state for facts a posting may simply not state.
 * `null` means "the posting does not say" and must never be read as "no".
 */
export const RemoteStatusSchema = z.enum(['REMOTE', 'HYBRID', 'ONSITE']).nullable();
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

export const SalaryRangeSchema = z
  .object({
    currency: z.string().nullable().default(null),
    min: z.number().nonnegative().nullable().default(null),
    max: z.number().nonnegative().nullable().default(null),
    period: z.enum(['YEARLY', 'MONTHLY', 'HOURLY']).nullable().default(null),
    /** Verbatim text from the posting, kept so we never have to guess twice. */
    raw: z.string().nullable().default(null),
  })
  .nullable();
export type SalaryRange = z.infer<typeof SalaryRangeSchema>;

export const ExperienceRangeSchema = z
  .object({
    minYears: z.number().min(0).max(60).nullable().default(null),
    maxYears: z.number().min(0).max(60).nullable().default(null),
    raw: z.string().nullable().default(null),
  })
  .nullable();
export type ExperienceRange = z.infer<typeof ExperienceRangeSchema>;

/** What a source adapter produces: loose, unvalidated, source-shaped. */
export const RawJobSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1).nullable().default(null),
  company: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  remote: z.string().nullable().default(null),
  salary: z.string().nullable().default(null),
  experience: z.string().nullable().default(null),
  skills: z.array(z.string()).default([]),
  url: z.string().nullable().default(null),
  applicationUrl: z.string().nullable().default(null),
  postedAt: z.union([z.string(), z.date()]).nullable().default(null),
  rawData: z.record(z.string(), z.unknown()).default({}),
});
export type RawJob = z.infer<typeof RawJobSchema>;

/** The canonical shape every source is normalised into. */
export const NormalizedJobSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  company: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  location: z.string().nullable(),
  remote: RemoteStatusSchema,
  salary: SalaryRangeSchema,
  experienceRequired: ExperienceRangeSchema,
  skills: z.array(z.string()),
  url: z.string().min(1),
  applicationUrl: z.string().nullable(),
  postedAt: z.date().nullable(),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
  fingerprint: z.string().length(64),
  /** sha256 of the fields that, when changed, warrant a re-evaluation. */
  contentHash: z.string().length(64),
  rawData: z.record(z.string(), z.unknown()),
});
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

/** A normalized job plus the persistence-layer id, as used downstream. */
export type StoredJob = NormalizedJob & { id: string; isNew: boolean };
