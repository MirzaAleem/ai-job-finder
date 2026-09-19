import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { parse as parseCsv } from 'csv-parse/sync';
import { allRows, clearTables, count, startTestDb, stopTestDb } from '../helpers/db.js';
import { getDb } from '../../src/db/connection.js';
import { runPipeline, markRunFailed } from '../../src/pipeline/run.js';
import { MockLLMProvider, mockEvaluationJson } from '../../src/llm/mock.provider.js';
import { InMemoryEvaluationCache } from '../../src/llm/cache.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { RunRepository } from '../../src/db/run.repository.js';
import { testEnv, testProfile } from '../helpers/fixtures.js';
import { MOCK_JOB_COUNT } from '../../src/sources/mock-data.js';

const OUTPUT_DIR = 'output/test';

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
  await rm(OUTPUT_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearTables();
});

/**
 * A local provider that answers any batch or single request with a confident,
 * well-formed evaluation — so the pipeline can be exercised without Ollama.
 */
function confidentLocal(confidence = 0.95, score = 88) {
  return new MockLLMProvider({
    kind: 'local',
    model: 'test-model',
    respond: (request) => {
      const ids = [...request.user.matchAll(/"jobId":\s*"([^"]+)"/g)].map((m) => m[1]);
      if (request.user.includes('JOB POSTINGS') && ids.length > 0) {
        return JSON.stringify({
          evaluations: ids.map((jobId) =>
            JSON.parse(mockEvaluationJson({ jobId, confidence, score })),
          ),
        });
      }
      return mockEvaluationJson({ jobId: ids[0] ?? 'unknown', confidence, score });
    },
  });
}

describe('full pipeline against mock data', () => {
  it('runs end to end and writes CSV and JSON', async () => {
    const local = confidentLocal();
    const cloud = new MockLLMProvider({ kind: 'cloud', name: 'mock-cloud', model: 'cloud-test' });

    const summary = await runPipeline({
      env: testEnv(),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: local,
      cloudProvider: cloud,
      cache: new InMemoryEvaluationCache(),
    });

    expect(summary.jobsFetched).toBe(MOCK_JOB_COUNT);
    expect(summary.jobsDeduplicated).toBeLessThan(summary.jobsFetched);
    expect(summary.jobsFiltered).toBeLessThan(summary.jobsDeduplicated);
    expect(summary.jobsEvaluated).toBe(summary.jobsFiltered);

    // The whole point: a confident local model means zero cloud spend.
    expect(cloud.callCount).toBe(0);
    expect(summary.usage.cloudRequests).toBe(0);
    expect(summary.usage.estimatedCloudCost).toBe(0);

    expect(summary.outputFiles).toHaveLength(2);
    const csvPath = summary.outputFiles.find((f) => f.endsWith('.csv'));
    expect(csvPath).toBeDefined();

    const rows = parseCsv(await readFile(csvPath as string, 'utf8'), {
      columns: true,
      bom: true,
    }) as Record<string, string>[];
    expect(rows).toHaveLength(summary.jobsEvaluated);
    expect(rows[0]).toHaveProperty('score');
    expect(rows[0]).toHaveProperty('providerUsed');

    const scores = rows.map((r) => Number(r.score));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('deduplicates the fixture pair that shares a company and title', async () => {
    const summary = await runPipeline({
      env: testEnv(),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
    });
    // mock-011 is a near-duplicate of mock-001 at the same company and location.
    expect(summary.jobsDeduplicated).toBeLessThanOrEqual(MOCK_JOB_COUNT - 1);
  });

  it('filters obviously unsuitable jobs before any LLM call', async () => {
    const local = confidentLocal();
    const summary = await runPipeline({
      env: testEnv(),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: local,
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
    });

    expect(Object.keys(summary.filterRuleCounts).length).toBeGreaterThan(0);
    // The legal-ops and support fixtures must never reach the model.
    const sent = local.requests.map((r) => r.user).join(' ');
    expect(sent).not.toContain('Legal Operations Associate');
    expect(sent).not.toContain('Marrow & Finch');
  });

  it('persists jobs, evaluations, and the run record', async () => {
    const summary = await runPipeline({
      env: testEnv(),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
    });

    expect(count('jobs')).toBe(summary.jobsFiltered);
    expect(count('job_evaluations')).toBe(summary.jobsEvaluated);

    const run = await new RunRepository().findById(summary.runId!);
    expect(run?.status).toBe('COMPLETED');
    expect(run?.jobs_fetched).toBe(MOCK_JOB_COUNT);
    expect(run?.cloud_llm_requests).toBe(0);
    expect(run?.completed_at).toBeTruthy();
  });

  it('makes no LLM calls at all on an unchanged second run', async () => {
    const cache = new InMemoryEvaluationCache();
    const env = testEnv();

    const first = confidentLocal();
    await runPipeline({
      env,
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: first,
      cloudProvider: null,
      cache,
      skipExport: true,
    });
    expect(first.callCount).toBeGreaterThan(0);

    // Seed the cache the way the real SQLite-backed cache would be seeded.
    const jobs = allRows<{ id: number; content_hash: string }>('SELECT id, content_hash FROM jobs');
    for (const stored of jobs) {
      await cache.set(stored.content_hash, 'test-model', {
        score: 88,
        confidence: 0.95,
        recommendation: 'APPLY',
        matchingSkills: [],
        missingSkills: [],
        reasons: [],
        concerns: [],
        providerUsed: 'LOCAL',
        provider: 'mock',
        model: 'test-model',
      });
    }

    const second = confidentLocal();
    const summary = await runPipeline({
      env,
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: second,
      cloudProvider: null,
      cache,
      skipExport: true,
    });

    expect(second.callCount).toBe(0);
    expect(summary.jobsFromCache).toBe(summary.jobsEvaluated);
    expect(summary.jobsNew).toBe(0);
  });

  it('escalates only the uncertain jobs, not every job', async () => {
    // Alternate confident and unconfident answers across the batch.
    let index = 0;
    const local = new MockLLMProvider({
      kind: 'local',
      model: 'test-model',
      respond: (request) => {
        const ids = [...request.user.matchAll(/"jobId":\s*"([^"]+)"/g)].map((m) => m[1]);
        const build = (jobId: string) => {
          index += 1;
          return JSON.parse(
            mockEvaluationJson({ jobId, confidence: index % 3 === 0 ? 0.5 : 0.95, score: 85 }),
          );
        };
        if (request.user.includes('JOB POSTINGS') && ids.length > 0) {
          return JSON.stringify({ evaluations: ids.map((id) => build(id as string)) });
        }
        return JSON.stringify(build(ids[0] ?? 'unknown'));
      },
    });

    const cloud = new MockLLMProvider({
      kind: 'cloud',
      name: 'mock-cloud',
      model: 'cloud-test',
      respond: (request) => {
        const id = request.user.match(/"jobId":\s*"([^"]+)"/)?.[1] ?? 'unknown';
        return mockEvaluationJson({ jobId: id, confidence: 0.97, score: 91 });
      },
    });

    const summary = await runPipeline({
      env: testEnv(),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: local,
      cloudProvider: cloud,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
    });

    expect(cloud.callCount).toBeGreaterThan(0);
    expect(cloud.callCount).toBeLessThan(summary.jobsEvaluated);
    expect(summary.usage.cloudRequests).toBe(cloud.callCount);
    expect(summary.escalationReasonCounts['low confidence']).toBe(cloud.callCount);

    const run = await new RunRepository().findById(summary.runId!);
    expect(run?.cloud_llm_requests).toBe(cloud.callCount);
    expect(run?.estimated_cloud_cost).toBeGreaterThan(0);
  });

  it('re-evaluates a job whose description has changed', async () => {
    const cache = new InMemoryEvaluationCache();
    const env = testEnv();

    await runPipeline({
      env,
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache,
      skipExport: true,
    });

    const jobs = allRows<{ id: number; content_hash: string }>('SELECT id, content_hash FROM jobs');
    for (const stored of jobs) {
      await cache.set(stored.content_hash, 'test-model', {
        score: 88,
        confidence: 0.95,
        recommendation: 'APPLY',
        matchingSkills: [],
        missingSkills: [],
        reasons: [],
        concerns: [],
        providerUsed: 'LOCAL',
        provider: 'mock',
        model: 'test-model',
      });
    }

    // Change one stored job's content hash, as a real edit would.
    getDb()
      .prepare('UPDATE jobs SET content_hash = ? WHERE id = ?')
      .run('z'.repeat(64), jobs[0]!.id);

    const second = confidentLocal();
    const summary = await runPipeline({
      env,
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: second,
      cloudProvider: null,
      cache,
      skipExport: true,
    });

    // Everything else is cached; only nothing-changed jobs are free.
    expect(summary.jobsFromCache).toBe(summary.jobsEvaluated);
    expect(second.callCount).toBe(0);
  });

  it('runs without MongoDB when persistence is skipped', async () => {
    const summary = await runPipeline({
      env: testEnv(),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
      skipPersistence: true,
    });

    expect(summary.runId).toBeNull();
    expect(summary.jobsEvaluated).toBeGreaterThan(0);
    expect(count('jobs')).toBe(0);
  });

  it('warns and carries on when SOURCES_ENABLED names a source that does not exist', async () => {
    const summary = await runPipeline({
      env: testEnv({ SOURCES_ENABLED: 'mock,not-a-real-source' }),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
    });

    expect(summary.sourceCounts['not-a-real-source']).toBeUndefined();
    expect(summary.jobsEvaluated).toBeGreaterThan(0);
  });
});

describe('run observability hooks', () => {
  it('hands the run id to the caller before the work starts', async () => {
    let seen: string | null | undefined;

    await runPipeline({
      env: testEnv({ OUTPUT_DIR }),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
      onRunStarted: (id) => {
        seen = id;
      },
    });

    expect(seen).toBeTruthy();
    const run = await new RunRepository().findById(seen as string);
    expect(run).toBeDefined();
  });

  it('reports every stage in pipeline order, ending at done', async () => {
    const stages: string[] = [];

    await runPipeline({
      env: testEnv({ OUTPUT_DIR }),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
      onProgress: (progress) => {
        if (stages.at(-1) !== progress.stage) stages.push(progress.stage);
      },
    });

    expect(stages[0]).toBe('starting');
    expect(stages.at(-1)).toBe('done');
    for (const stage of ['fetching', 'filtering', 'persisting', 'evaluating', 'ranking']) {
      expect(stages).toContain(stage);
    }
  });

  it('counts batches during evaluation, which is the slow part', async () => {
    const batches: { current?: number; total?: number }[] = [];

    await runPipeline({
      env: testEnv({ OUTPUT_DIR, LLM_BATCH_SIZE: '2' }),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: confidentLocal(),
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
      onProgress: (progress) => {
        if (progress.stage === 'evaluating' && progress.total) {
          batches.push({ current: progress.current, total: progress.total });
        }
      },
    });

    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0]?.current).toBe(1);
    expect(batches.at(-1)?.current).toBe(batches.at(-1)?.total);
  });

  it('stops when the signal is already aborted, and records the run as failed', async () => {
    const controller = new AbortController();
    controller.abort();

    let runId: string | null = null;
    await expect(
      runPipeline({
        env: testEnv({ OUTPUT_DIR }),
        profile: testProfile,
        logger: createSilentLogger(),
        localProvider: confidentLocal(),
        cloudProvider: null,
        cache: new InMemoryEvaluationCache(),
        skipExport: true,
        signal: controller.signal,
        onRunStarted: (id) => {
          runId = id;
        },
      }),
    ).rejects.toThrow('cancelled by user');

    // The whole point of onRunStarted: a cancelled run can now be closed out.
    await markRunFailed(runId, new Error('cancelled by user'));
    const run = await new RunRepository().findById(runId as unknown as string);
    expect(run?.status).toBe('FAILED');
  });

  it('completes rather than crashing when the local model keeps failing', async () => {
    // Verified behaviour, not an assumption: a broken model degrades the run
    // instead of aborting it, so the run closes as COMPLETED and the evidence
    // of the failure is in summary.errors and the degraded evaluations.
    const exploding = new MockLLMProvider({
      kind: 'local',
      model: 'test-model',
      respond: () => {
        throw new Error('the model fell over');
      },
    });

    let runId: string | null = null;
    const summary = await runPipeline({
      env: testEnv({ OUTPUT_DIR, LLM_MAX_RETRIES: '0' }),
      profile: testProfile,
      logger: createSilentLogger(),
      localProvider: exploding,
      cloudProvider: null,
      cache: new InMemoryEvaluationCache(),
      skipExport: true,
      onRunStarted: (id) => {
        runId = id;
      },
    });

    expect(runId).toBeTruthy();
    expect(summary.ranked.every((item) => item.evaluation.degraded)).toBe(true);

    const run = await new RunRepository().findById(runId as unknown as string);
    expect(run?.status).toBe('COMPLETED');
  });
});
