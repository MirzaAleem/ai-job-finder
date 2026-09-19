import type { RawJob } from '../domain/job.schema.js';
import type { FetchJobsOptions, JobSource, SourceStatus } from './source.js';
import { mockRawJobs } from './mock-data.js';

/**
 * Offline source backing every test and the default `pnpm jobs:run`.
 * The fixture set deliberately includes vague, contradictory and off-target
 * postings so the filter and escalation paths are exercised without a network.
 */
export class MockJobSource implements JobSource {
  readonly name = 'mock';
  readonly status: SourceStatus = 'SUPPORTED';
  readonly notes = 'Local fixtures; no network access.';

  constructor(private readonly jobs: RawJob[] = mockRawJobs()) {}

  async fetchJobs(options: FetchJobsOptions = {}): Promise<RawJob[]> {
    let results = [...this.jobs];

    if (options.queries?.length) {
      const needles = options.queries.map((q) => q.toLowerCase());
      results = results.filter((job) => {
        const hay = `${job.title ?? ''} ${job.description ?? ''}`.toLowerCase();
        return needles.some((needle) => hay.includes(needle));
      });
    }

    if (options.limit !== undefined) results = results.slice(0, options.limit);
    return results;
  }
}
