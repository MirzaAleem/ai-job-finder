import { z } from 'zod';

/**
 * Where a job sits in the user's own pipeline. Distinct from the LLM's
 * `recommendation`, which is a judgement about fit — this is what the user
 * actually did about it.
 */
export const ApplicationStatusSchema = z.enum([
  'NEW',
  'INTERESTED',
  'APPLIED',
  'INTERVIEWING',
  'REJECTED',
  'OFFER',
  'DISMISSED',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const APPLICATION_STATUSES = ApplicationStatusSchema.options;

/** Statuses hidden from the default view so the daily queue stays short. */
export const CLOSED_STATUSES: ApplicationStatus[] = ['DISMISSED', 'REJECTED'];

export const ApplicationStatusLabels: Record<ApplicationStatus, string> = {
  NEW: 'New',
  INTERESTED: 'Interested',
  APPLIED: 'Applied',
  INTERVIEWING: 'Interviewing',
  REJECTED: 'Rejected',
  OFFER: 'Offer',
  DISMISSED: 'Dismissed',
};

export const ApplicationUpdateSchema = z.object({
  status: ApplicationStatusSchema.optional(),
  notes: z.string().max(10_000).optional(),
});
export type ApplicationUpdate = z.infer<typeof ApplicationUpdateSchema>;

export interface ApplicationRecord {
  jobId: string;
  status: ApplicationStatus;
  notes: string;
  appliedAt: Date | null;
  statusHistory: Array<{ status: ApplicationStatus; at: Date }>;
  updatedAt: Date | null;
}
