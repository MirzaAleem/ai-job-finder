import { z } from 'zod';

/** How much the candidate wants remote work. */
export const RemotePreferenceSchema = z.enum([
  'REMOTE_ONLY',
  'REMOTE_PREFERRED',
  'HYBRID',
  'ONSITE',
  'ANY',
]);
export type RemotePreference = z.infer<typeof RemotePreferenceSchema>;

export const SalaryExpectationSchema = z.object({
  currency: z.string().min(1).default('INR'),
  /** Annual figures, in whole currency units (not lakhs, not thousands). */
  minimum: z.number().nonnegative().optional(),
  preferred: z.number().nonnegative().optional(),
});

export const CandidateProfileSchema = z
  .object({
    targetRoles: z.array(z.string().min(1)).min(1, 'at least one target role is required'),
    preferredLocations: z.array(z.string().min(1)).default([]),
    remotePreference: RemotePreferenceSchema.default('ANY'),

    yearsOfExperience: z.number().min(0).max(60),
    /** Optional hard ceiling; jobs demanding far more are penalised, not auto-rejected. */
    maximumExperienceAccepted: z.number().min(0).max(60).optional(),

    salary: SalaryExpectationSchema.default({ currency: 'INR' }),

    requiredSkills: z.array(z.string().min(1)).default([]),
    preferredSkills: z.array(z.string().min(1)).default([]),

    excludedRoles: z.array(z.string().min(1)).default([]),
    excludedIndustries: z.array(z.string().min(1)).default([]),
    excludedKeywords: z.array(z.string().min(1)).default([]),

    education: z.string().optional(),
    workAuthorization: z.string().optional(),
    noticePeriod: z.string().optional(),

    additionalPreferences: z.array(z.string()).default([]),
  })
  .strict();

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;

/**
 * The subset of the profile that is safe and useful to put in an LLM prompt.
 * Deliberately excludes nothing sensitive today, but centralises the decision
 * so personal fields added later are not leaked to a provider by accident.
 */
export function toPromptProfile(profile: CandidateProfile) {
  return {
    targetRoles: profile.targetRoles,
    preferredLocations: profile.preferredLocations,
    remotePreference: profile.remotePreference,
    yearsOfExperience: profile.yearsOfExperience,
    salary: profile.salary,
    requiredSkills: profile.requiredSkills,
    preferredSkills: profile.preferredSkills,
    excludedRoles: profile.excludedRoles,
    excludedIndustries: profile.excludedIndustries,
    excludedKeywords: profile.excludedKeywords,
    education: profile.education ?? 'unknown',
    workAuthorization: profile.workAuthorization ?? 'unknown',
    noticePeriod: profile.noticePeriod ?? 'unknown',
    additionalPreferences: profile.additionalPreferences,
  };
}
