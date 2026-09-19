import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allRows, clearTables, count, firstRow, startTestDb, stopTestDb } from '../helpers/db.js';
import { getDb } from '../../src/db/connection.js';
import { JobRepository } from '../../src/db/job.repository.js';
import { RunRepository } from '../../src/db/run.repository.js';
import { SqliteEvaluationCache } from '../../src/db/evaluation-cache.js';
import type { EvaluationRow, JobRow } from '../../src/db/rows.js';
import type { FinalEvaluation } from '../../src/domain/evaluation.schema.js';
import { job, testProfile } from '../helpers/fixtures.js';

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await clearTables();
});

function finalEvaluation(jobId: string, overrides: Partial<FinalEvaluation> = {}): FinalEvaluation {
  return {
    jobId,
    score: 88,
    confidence: 0.91,
    recommendation: 'APPLY',
    matchingSkills: ['TypeScript'],
    missingSkills: ['Kubernetes'],
    reasons: ['Good match'],
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

describe('job persistence and history', () => {
  const repository = new JobRepository();

  it('creates a job as NEW on first sight', async () => {
    const result = await repository.upsert(job());
    expect(result.state).toBe('NEW');
    expect(result.job.isNew).toBe(true);
    expect(count('jobs')).toBe(1);
  });

  it('reports an identical re-scrape as UNCHANGED', async () => {
    await repository.upsert(job());
    const second = await repository.upsert(job());
    expect(second.state).toBe('UNCHANGED');
    expect(count('jobs')).toBe(1);
  });

  it('reports a changed description as CHANGED', async () => {
    await repository.upsert(job());
    const changed = await repository.upsert(
      job({ description: 'Completely rewritten description with Kafka and Kubernetes.' }),
    );
    expect(changed.state).toBe('CHANGED');
    expect(count('jobs')).toBe(1);
  });

  it('preserves firstSeenAt across re-scrapes but advances lastSeenAt', async () => {
    const original = job();
    original.firstSeenAt = new Date('2026-01-01T00:00:00Z');
    original.lastSeenAt = new Date('2026-01-01T00:00:00Z');
    await repository.upsert(original);

    const later = job();
    later.firstSeenAt = new Date('2026-09-12T00:00:00Z');
    later.lastSeenAt = new Date('2026-09-12T00:00:00Z');
    const result = await repository.upsert(later);

    const stored = firstRow<JobRow>('SELECT * FROM jobs WHERE external_id = ?', 'test-1');
    expect(stored?.first_seen_at).toBe('2026-01-01T00:00:00.000Z');
    expect(stored?.last_seen_at).toBe('2026-09-12T00:00:00.000Z');
    // The returned job carries the preserved date, not the one just scraped.
    expect(result.job.firstSeenAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('keeps jobs from different sources separate', async () => {
    await repository.upsert(job({ source: 'mock' }));
    await repository.upsert(job({ source: 'import' }));
    expect(count('jobs')).toBe(2);
  });

  it('enforces uniqueness on (source, externalId)', async () => {
    const { job: stored } = await repository.upsert(job());
    const now = new Date().toISOString();
    // Going around the repository: the constraint must live in the schema, not
    // in the upsert's SELECT-then-INSERT.
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO jobs (source, external_id, company, title, url, first_seen_at,
             last_seen_at, fingerprint, content_hash, created_at, updated_at)
           VALUES (?, ?, 'X', 'Y', 'https://x.test/dup', ?, ?, ?, ?, ?, ?)`,
        )
        .run(stored.source, stored.externalId, now, now, 'f'.repeat(64), 'c'.repeat(64), now, now),
    ).toThrow(/UNIQUE/i);
  });

  it('upserts many jobs in one call', async () => {
    const results = await repository.upsertMany([
      job({ externalId: '1', url: 'https://x.test/1' }),
      job({ externalId: '2', url: 'https://x.test/2' }),
    ]);
    expect(results).toHaveLength(2);
    expect(count('jobs')).toBe(2);
  });

  it('round-trips a job through JSON columns without losing structure', async () => {
    const original = job();
    const { job: stored } = await repository.upsert(original);
    const found = await repository.findJobsById([stored.id]);
    const roundTripped = found.get(stored.id);

    expect(roundTripped?.skills).toEqual(original.skills);
    expect(roundTripped?.salary).toEqual(original.salary);
    expect(roundTripped?.experienceRequired).toEqual(original.experienceRequired);
    expect(roundTripped?.rawData).toEqual(original.rawData);
    expect(roundTripped?.postedAt?.toISOString()).toBe(original.postedAt?.toISOString());
  });
});

describe('evaluation persistence', () => {
  const repository = new JobRepository();
  const runs = new RunRepository();

  it('stores an evaluation linked to its job and run', async () => {
    const { job: stored } = await repository.upsert(job());
    const runId = await runs.start(new Date());

    await repository.saveEvaluation(finalEvaluation(stored.id), stored.id, runId);

    const row = firstRow<EvaluationRow>('SELECT * FROM job_evaluations');
    expect(row?.score).toBe(88);
    expect(row?.provider_used).toBe('LOCAL');
    expect(String(row?.job_id)).toBe(stored.id);
    expect(String(row?.run_id)).toBe(runId);
  });

  it('stores both the local and cloud evaluations after an escalation', async () => {
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(
      finalEvaluation(stored.id, {
        providerUsed: 'CLOUD',
        escalated: true,
        escalationReasons: ['LOW_CONFIDENCE'],
        localEvaluation: {
          score: 60,
          confidence: 0.5,
          recommendation: 'SKIP',
          matchingSkills: [],
          missingSkills: [],
          reasons: [],
          concerns: [],
          needsCloud: true,
          escalationReason: 'unsure',
          uncertainties: {
            seniority: false,
            experience: false,
            salary: false,
            requirements: false,
            conflicting: false,
          },
        },
        cloudEvaluation: {
          score: 88,
          confidence: 0.95,
          recommendation: 'APPLY',
          matchingSkills: [],
          missingSkills: [],
          reasons: [],
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
        },
      }),
      stored.id,
      null,
    );

    const row = firstRow<EvaluationRow>('SELECT * FROM job_evaluations');
    expect(JSON.parse(row!.local_evaluation!).score).toBe(60);
    expect(JSON.parse(row!.cloud_evaluation!).score).toBe(88);
    expect(JSON.parse(row!.escalation_reason)).toEqual(['LOW_CONFIDENCE']);
    expect(row?.escalated).toBe(1);
  });

  it('returns the latest evaluation per job', async () => {
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(finalEvaluation(stored.id, { score: 50 }), stored.id, null);
    await new Promise((r) => setTimeout(r, 10));
    await repository.saveEvaluation(finalEvaluation(stored.id, { score: 95 }), stored.id, null);

    const latest = await repository.latestEvaluations([stored.id]);
    expect(latest.get(stored.id)?.score).toBe(95);
  });

  it('breaks a same-millisecond tie by insertion order, not arbitrarily', async () => {
    // ISO timestamps only go to the millisecond, so two evaluations written in
    // the same tick compare equal. The id is the tiebreaker.
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(finalEvaluation(stored.id, { score: 10 }), stored.id, null);
    await repository.saveEvaluation(finalEvaluation(stored.id, { score: 20 }), stored.id, null);

    const latest = await repository.latestEvaluations([stored.id]);
    expect(latest.get(stored.id)?.score).toBe(20);
  });

  it('returns an empty map when asked for no jobs', async () => {
    expect((await repository.latestEvaluations([])).size).toBe(0);
    expect((await repository.findJobsById([])).size).toBe(0);
  });
});

describe('SQLite-backed evaluation cache', () => {
  const repository = new JobRepository();

  it('misses before anything is stored', async () => {
    const cache = new SqliteEvaluationCache();
    expect(await cache.get('z'.repeat(64), 'test-model')).toBeNull();
  });

  it('hits on a prior evaluation of the same content by the same model', async () => {
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(finalEvaluation(stored.id), stored.id, null);

    const cache = new SqliteEvaluationCache();
    const hit = await cache.get('a'.repeat(64), 'test-model');
    expect(hit?.score).toBe(88);
  });

  it('misses when the model differs — a model change invalidates prior judgements', async () => {
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(finalEvaluation(stored.id), stored.id, null);

    const cache = new SqliteEvaluationCache();
    expect(await cache.get('a'.repeat(64), 'a-different-model')).toBeNull();
  });

  it('caches an ESCALATED job under the local model, not the cloud model', async () => {
    // Regression: evaluations are persisted with `model` = whichever provider
    // won, so an escalated job was stored under the cloud model while the cache
    // looked it up under the local one. Every escalated job then re-paid for a
    // cloud call on every run.
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(
      finalEvaluation(stored.id, {
        providerUsed: 'CLOUD',
        escalated: true,
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        localModel: 'llama3.1:8b',
      }),
      stored.id,
      null,
    );

    const cache = new SqliteEvaluationCache();
    const hit = await cache.get('a'.repeat(64), 'llama3.1:8b');
    expect(hit).not.toBeNull();
    expect(hit?.score).toBe(88);
    // And the cloud verdict is what gets reused.
    expect(hit?.providerUsed).toBe('CLOUD');
  });

  it('still misses when the local model changes, even for an escalated job', async () => {
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(
      finalEvaluation(stored.id, {
        providerUsed: 'CLOUD',
        model: 'gemini-3.6-flash',
        localModel: 'llama3.1:8b',
      }),
      stored.id,
      null,
    );

    const cache = new SqliteEvaluationCache();
    expect(await cache.get('a'.repeat(64), 'qwen3:8b')).toBeNull();
  });

  it('misses when the content hash differs', async () => {
    const { job: stored } = await repository.upsert(job());
    await repository.saveEvaluation(finalEvaluation(stored.id), stored.id, null);

    const cache = new SqliteEvaluationCache();
    expect(await cache.get('b'.repeat(64), 'test-model')).toBeNull();
  });
});

describe('profile and run records', () => {
  const repository = new JobRepository();
  const runs = new RunRepository();

  it('stores a profile snapshot once per version', async () => {
    const first = await repository.recordProfile(testProfile);
    const second = await repository.recordProfile(testProfile);
    expect(first).toBe(second);
    expect(count('candidate_profiles')).toBe(1);
  });

  it('stores a new snapshot when the profile changes', async () => {
    await repository.recordProfile(testProfile);
    await repository.recordProfile({ ...testProfile, yearsOfExperience: 10 });
    expect(count('candidate_profiles')).toBe(2);
  });

  it('opens a run as RUNNING and closes it with its statistics', async () => {
    const runId = await runs.start(new Date());
    expect((await runs.findById(runId))?.status).toBe('RUNNING');

    await runs.complete(runId, {
      sourceCounts: { mock: 174 },
      jobsFetched: 174,
      jobsDeduplicated: 137,
      jobsFiltered: 52,
      jobsEvaluated: 52,
      jobsFromCache: 0,
      jobsNew: 52,
      localLLMRequests: 11,
      cloudLLMRequests: 0,
      cloudInputTokens: 0,
      cloudOutputTokens: 0,
      estimatedCloudCost: 0,
      escalationReasonCounts: {},
      highPriorityCount: 9,
      applyCount: 20,
      considerCount: 13,
      skipCount: 10,
      outputFiles: ['output/jobs.csv'],
      errors: [],
    });

    const stored = await runs.findById(runId);
    expect(stored?.jobs_fetched).toBe(174);
    expect(stored?.high_priority_count).toBe(9);
    expect(stored?.status).toBe('COMPLETED');
    expect(stored?.completed_at).toBeTruthy();
    expect(JSON.parse(stored!.source_counts)).toEqual({ mock: 174 });
  });

  it('marks a run FAILED and keeps the errors already recorded', async () => {
    const runId = await runs.start(new Date());
    await runs.fail(runId, new Error('ollama went away'));

    const stored = await runs.findById(runId);
    expect(stored?.status).toBe('FAILED');
    expect(JSON.parse(stored!.errors)).toEqual(['ollama went away']);
  });

  it('creates the declared indexes', () => {
    const names = allRows<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'`,
    ).map((row) => row.name);
    expect(names).toContain('idx_jobs_source_external');
    expect(names).toContain('idx_jobs_fingerprint');
  });

  it('finds recently seen jobs', async () => {
    const recentJob = job({ externalId: 'recent', url: 'https://x.test/recent' });
    recentJob.firstSeenAt = new Date();
    recentJob.lastSeenAt = new Date();
    await repository.upsert(recentJob);

    const since = new Date(Date.now() - 60_000);
    const recent = await repository.findRecentJobs(since);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.isNew).toBe(true);
  });
});
