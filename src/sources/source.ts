import type { RawJob } from '../domain/job.schema.js';

export interface FetchJobsOptions {
  /** Search terms; sources that do not support search ignore this. */
  queries?: string[];
  locations?: string[];
  /** Upper bound on jobs returned, so a bad selector cannot run away. */
  limit?: number;
  maxPages?: number;
  /** Only consider postings at least this recent, where the source exposes it. */
  postedWithinDays?: number;
}

export type SourceStatus =
  /** Implemented and verified to return jobs. */
  | 'SUPPORTED'
  /** Implemented, but not verified against the live site; opt-in only. */
  | 'EXPERIMENTAL'
  /** Cannot be automated appropriately; use the import path instead. */
  | 'UNSUPPORTED';

export interface JobSource {
  readonly name: string;
  readonly status: SourceStatus;
  /** Shown to the user when the source is skipped or fails. */
  readonly notes?: string;
  fetchJobs(options: FetchJobsOptions): Promise<RawJob[]>;
  close?(): Promise<void>;
}

export class SourceUnsupportedError extends Error {
  constructor(sourceName: string, detail: string) {
    super(`Source "${sourceName}" is not supported: ${detail}`);
    this.name = 'SourceUnsupportedError';
  }
}
