import { describe, expect, it } from 'vitest';
import { parse as parseCsv } from 'csv-parse/sync';
import { buildCsv, CSV_COLUMNS, outputFileName, toCsvRow } from '../../src/export/csv.js';
import { buildJsonExport } from '../../src/export/json.js';
import { countRecommendations, rankJobs } from '../../src/pipeline/rank.js';
import type { RankedJob } from '../../src/export/types.js';
import type { FinalEvaluation } from '../../src/domain/evaluation.schema.js';
import { job } from '../helpers/fixtures.js';

function evaluation(overrides: Partial<FinalEvaluation> = {}): FinalEvaluation {
  return {
    jobId: 'job-1',
    score: 88,
    confidence: 0.91,
    recommendation: 'APPLY',
    matchingSkills: ['TypeScript', 'Node.js'],
    missingSkills: ['Kubernetes'],
    reasons: ['Strong backend match'],
    concerns: [],
    needsCloud: false,
    escalationReason: null,
    uncertainties: {
      seniority: false,
      experience: false,
      salary: false,
      requirements: false,
      conflicting: false,
    },
    providerUsed: 'LOCAL',
    localEvaluation: null,
    cloudEvaluation: null,
    escalated: false,
    escalationReasons: [],
    degraded: false,
    provider: 'ollama',
    model: 'test-model',
    localModel: 'test-model',
    contentHash: 'a'.repeat(64),
    fromCache: false,
    ...overrides,
  };
}

const ranked = (overrides: Partial<RankedJob> = {}): RankedJob => ({
  job: job(),
  evaluation: evaluation(),
  isNew: true,
  ...overrides,
});

describe('CSV generation', () => {
  it('emits every required column, in order', () => {
    const csv = buildCsv([ranked()]);
    const header = csv.split('\n')[0] ?? '';
    expect(header.trim()).toBe(CSV_COLUMNS.join(','));
  });

  it('produces a parseable row', () => {
    const rows = parseCsv(buildCsv([ranked()]), { columns: true }) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company).toBe('Acme Corp');
    expect(rows[0]?.recommendation).toBe('APPLY');
    expect(rows[0]?.score).toBe('88');
  });

  it('escapes commas and quotes rather than corrupting the row', () => {
    const item = ranked({
      job: job({ title: 'Engineer, Senior "Backend"' }),
      evaluation: evaluation({ reasons: ['Has commas, and "quotes"'] }),
    });
    const rows = parseCsv(buildCsv([item]), { columns: true }) as Record<string, string>[];
    expect(rows[0]?.title).toBe('Engineer, Senior "Backend"');
    expect(rows[0]?.reasons).toBe('Has commas, and "quotes"');
  });

  it('survives newlines embedded in model output', () => {
    const item = ranked({ evaluation: evaluation({ concerns: ['line one\nline two'] }) });
    const rows = parseCsv(buildCsv([item]), { columns: true }) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.concerns).toContain('line one');
  });

  it('writes "unknown" rather than an empty cell for missing data', () => {
    const row = toCsvRow(
      ranked({ job: job({ salary: null, experience: null, location: null, remote: null }) }),
    );
    expect(row.salary).toBe('unknown');
    expect(row.experienceRequired).toBe('unknown');
    expect(row.location).toBe('unknown');
    expect(row.remote).toBe('unknown');
  });

  it('joins skill lists into a single cell', () => {
    const row = toCsvRow(ranked());
    expect(row.matchingSkills).toBe('TypeScript; Node.js');
  });

  it('falls back to the job URL when no application URL exists', () => {
    const row = toCsvRow(ranked({ job: job({ applicationUrl: null }) }));
    expect(row.applicationUrl).toBe(row.jobUrl);
  });

  it('names the file with the run date', () => {
    expect(outputFileName('jobs', 'csv', new Date('2026-09-12T10:00:00Z'))).toBe(
      'jobs-2026-09-12.csv',
    );
  });

  it('handles an empty result set without throwing', () => {
    expect(buildCsv([])).toContain('score');
  });
});

describe('ranking', () => {
  it('sorts by score descending', () => {
    const items = rankJobs([
      ranked({ evaluation: evaluation({ score: 70 }) }),
      ranked({ evaluation: evaluation({ score: 95 }) }),
      ranked({ evaluation: evaluation({ score: 85 }) }),
    ]);
    expect(items.map((i) => i.evaluation.score)).toEqual([95, 85, 70]);
  });

  it('prefers newly discovered jobs at an equal score', () => {
    const items = rankJobs([
      ranked({ isNew: false, job: job({ company: 'Old Co' }) }),
      ranked({ isNew: true, job: job({ company: 'New Co' }) }),
    ]);
    expect(items[0]?.job.company).toBe('New Co');
  });

  it('prefers more recently posted jobs at an equal score and novelty', () => {
    const older = ranked({ job: job({ postedAt: '10 days ago', company: 'Older' }) });
    const newer = ranked({ job: job({ postedAt: 'today', company: 'Newer' }) });
    expect(rankJobs([older, newer])[0]?.job.company).toBe('Newer');
  });

  it('counts recommendations', () => {
    const counts = countRecommendations([
      ranked({ evaluation: evaluation({ recommendation: 'HIGH_PRIORITY' }) }),
      ranked({ evaluation: evaluation({ recommendation: 'APPLY' }) }),
      ranked({ evaluation: evaluation({ recommendation: 'APPLY' }) }),
      ranked({ evaluation: evaluation({ recommendation: 'SKIP' }) }),
    ]);
    expect(counts).toEqual({ HIGH_PRIORITY: 1, APPLY: 2, CONSIDER: 0, SKIP: 1 });
  });
});

describe('JSON export', () => {
  it('includes run metadata and the full evaluation detail', () => {
    const output = buildJsonExport([ranked()], {
      generatedAt: '2026-09-12T00:00:00.000Z',
      totalJobs: 1,
      newJobs: 1,
      localModel: 'test-model',
      cloudModel: null,
      cloudRequests: 0,
      estimatedCloudCost: 0,
    });

    expect(output.meta.totalJobs).toBe(1);
    expect(output.meta.cloudRequests).toBe(0);
    expect(output.jobs[0]?.job.company).toBe('Acme Corp');
    expect(output.jobs[0]?.providerUsed).toBe('LOCAL');
  });

  it('serialises dates as ISO strings', () => {
    const output = buildJsonExport([ranked()], {
      generatedAt: '2026-09-12T00:00:00.000Z',
      totalJobs: 1,
      newJobs: 1,
      localModel: 'm',
      cloudModel: null,
      cloudRequests: 0,
      estimatedCloudCost: 0,
    });
    expect(typeof output.jobs[0]?.job.firstSeenAt).toBe('string');
    expect(() => JSON.stringify(output)).not.toThrow();
  });
});
