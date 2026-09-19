import type { FinalEvaluation } from '../domain/evaluation.schema.js';
import type { NormalizedJob } from '../domain/job.schema.js';

/** A job joined with its settled evaluation — the unit the exporters write. */
export interface RankedJob {
  job: NormalizedJob;
  evaluation: FinalEvaluation;
  isNew: boolean;
}
