import { describe, expect, it } from 'vitest';
import { deduplicateJobs } from '../../src/pipeline/dedupe.js';
import { job } from '../helpers/fixtures.js';

describe('deduplication', () => {
  it('keeps distinct jobs', () => {
    const result = deduplicateJobs([
      job({ externalId: 'a', url: 'https://x.test/a', title: 'Backend Engineer' }),
      job({ externalId: 'b', url: 'https://x.test/b', title: 'Frontend Engineer' }),
    ]);
    expect(result.jobs).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });

  it('collapses the same external id from the same source', () => {
    const result = deduplicateJobs([
      job({ externalId: 'same', url: 'https://x.test/1' }),
      job({ externalId: 'same', url: 'https://x.test/2' }),
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicates[0]?.strategy).toBe('EXTERNAL_ID');
  });

  it('collapses jobs whose URLs differ only by tracking parameters', () => {
    const result = deduplicateJobs([
      job({ externalId: 'a', url: 'https://x.test/role/1' }),
      job({ externalId: 'b', url: 'https://x.test/role/1?utm_source=newsletter' }),
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicates[0]?.strategy).toBe('URL');
  });

  it('collapses the same title reposted under a different URL', () => {
    const result = deduplicateJobs([
      job({ externalId: 'a', url: 'https://x.test/a', title: 'Senior Backend Engineer' }),
      job({ externalId: 'b', url: 'https://x.test/b', title: 'Senior Backend Engineer' }),
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicates[0]?.strategy).toBe('FUZZY');
  });

  it('collapses recruiter noise around an otherwise identical title', () => {
    const result = deduplicateJobs([
      job({ externalId: 'a', url: 'https://x.test/a', title: 'Senior Backend Engineer' }),
      job({
        externalId: 'b',
        url: 'https://x.test/b',
        title: 'URGENT!!! Senior Backend Engineer - Immediate Joiners',
      }),
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicates[0]?.strategy).toBe('FUZZY');
  });

  it('keeps both when the location differs — a different city is a different job', () => {
    const result = deduplicateJobs([
      job({ externalId: 'a', url: 'https://x.test/a', location: 'Bengaluru, India' }),
      job({ externalId: 'b', url: 'https://x.test/b', location: 'Pune, India' }),
    ]);
    expect(result.jobs).toHaveLength(2);
  });

  it('keeps both when the company differs, even with an identical title', () => {
    const result = deduplicateJobs([
      job({ externalId: 'a', url: 'https://x.test/a', company: 'Acme' }),
      job({ externalId: 'b', url: 'https://x.test/b', company: 'Globex' }),
    ]);
    expect(result.jobs).toHaveLength(2);
  });

  it('is conservative: unrelated titles at one company are not merged', () => {
    const result = deduplicateJobs([
      job({ externalId: 'a', url: 'https://x.test/a', title: 'Backend Engineer' }),
      job({ externalId: 'b', url: 'https://x.test/b', title: 'Data Scientist' }),
    ]);
    expect(result.jobs).toHaveLength(2);
  });

  it('keeps the richer of two duplicates', () => {
    const sparse = job({ externalId: 'same', description: 'Short.', salary: null });
    const rich = job({
      externalId: 'same',
      description: 'A much longer description with real detail about the role.',
      salary: '₹40 LPA',
    });
    const result = deduplicateJobs([sparse, rich]);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.salary).not.toBeNull();
  });

  it('preserves the earliest firstSeenAt when merging', () => {
    const older = job({ externalId: 'same', description: 'Short.' });
    older.firstSeenAt = new Date('2026-01-01T00:00:00Z');
    const newer = job({
      externalId: 'same',
      description: 'Much longer and more detailed description of the same role.',
    });
    newer.firstSeenAt = new Date('2026-09-01T00:00:00Z');

    const result = deduplicateJobs([older, newer]);
    expect(result.jobs[0]?.firstSeenAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('can be run with fuzzy matching disabled', () => {
    const result = deduplicateJobs(
      [
        job({ externalId: 'a', url: 'https://x.test/a', title: 'Senior Backend Engineer' }),
        job({ externalId: 'b', url: 'https://x.test/b', title: 'Sr Backend Engineer' }),
      ],
      { enableFuzzy: false },
    );
    expect(result.jobs).toHaveLength(2);
  });
});
