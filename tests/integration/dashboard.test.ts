import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTables, firstRow, startTestDb, stopTestDb } from '../helpers/db.js';
import { startTestDashboard, type TestDashboard } from '../helpers/dashboard.js';
import { filtersFromQuery } from '../../src/dashboard/server.js';
import { DashboardRepository } from '../../src/db/dashboard.repository.js';
import { JobRepository } from '../../src/db/job.repository.js';
import { RunRepository } from '../../src/db/run.repository.js';
import type { ApplicationRow } from '../../src/db/rows.js';
import type { FinalEvaluation } from '../../src/domain/evaluation.schema.js';
import { job } from '../helpers/fixtures.js';

let harness: TestDashboard;
const jobRepo = new JobRepository();
const dashRepo = new DashboardRepository();

beforeAll(async () => {
  await startTestDb();
  harness = await startTestDashboard();
});

afterAll(async () => {
  await harness.close();
  await stopTestDb();
});

beforeEach(async () => {
  await clearTables();
});

const api = (route: string) => harness.api(route);

/** Zero-valued run statistics; tests override only the fields they assert on. */
const EMPTY_RUN_STATS = {
  sourceCounts: {},
  jobsFetched: 0,
  jobsDeduplicated: 0,
  jobsFiltered: 0,
  jobsEvaluated: 0,
  jobsFromCache: 0,
  jobsNew: 0,
  localLLMRequests: 0,
  cloudLLMRequests: 0,
  cloudInputTokens: 0,
  cloudOutputTokens: 0,
  estimatedCloudCost: 0,
  escalationReasonCounts: {},
  highPriorityCount: 0,
  applyCount: 0,
  considerCount: 0,
  skipCount: 0,
  outputFiles: [],
  errors: [],
};

function evaluation(jobId: string, overrides: Partial<FinalEvaluation> = {}): FinalEvaluation {
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
    degraded: false,
    escalationReasons: [],
    provider: 'ollama',
    model: 'test-model',
    localModel: 'test-model',
    contentHash: 'a'.repeat(64),
    fromCache: false,
    ...overrides,
  };
}

/** Persist a job plus its evaluation, returning the job id. */
async function seed(
  jobOverrides: Parameters<typeof job>[0] = {},
  evalOverrides: Partial<FinalEvaluation> = {},
): Promise<string> {
  const { job: stored } = await jobRepo.upsert(job(jobOverrides));
  await jobRepo.saveEvaluation(evaluation(stored.id, evalOverrides), stored.id, null);
  return stored.id;
}

describe('GET /api/jobs', () => {
  it('returns jobs joined to their evaluation', async () => {
    await seed();
    const body = await fetch(api('/api/jobs')).then((r) => r.json());

    expect(body.count).toBe(1);
    expect(body.jobs[0].company).toBe('Acme Corp');
    expect(body.jobs[0].score).toBe(88);
    expect(body.jobs[0].recommendation).toBe('APPLY');
    expect(body.jobs[0].status).toBe('NEW');
    expect(body.jobs[0].matchingSkills).toEqual(['TypeScript']);
  });

  it('sorts by score descending', async () => {
    await seed({ externalId: 'a', url: 'https://x.test/a' }, { score: 70 });
    await seed({ externalId: 'b', url: 'https://x.test/b' }, { score: 95 });
    await seed({ externalId: 'c', url: 'https://x.test/c' }, { score: 85 });

    const body = await fetch(api('/api/jobs')).then((r) => r.json());
    expect(body.jobs.map((j: { score: number }) => j.score)).toEqual([95, 85, 70]);
  });

  it('filters by minimum score', async () => {
    await seed({ externalId: 'a', url: 'https://x.test/a' }, { score: 40 });
    await seed({ externalId: 'b', url: 'https://x.test/b' }, { score: 95 });

    const body = await fetch(api('/api/jobs?minScore=80')).then((r) => r.json());
    expect(body.count).toBe(1);
    expect(body.jobs[0].score).toBe(95);
  });

  it('filters by recommendation, accepting a comma-separated list', async () => {
    await seed({ externalId: 'a', url: 'https://x.test/a' }, { recommendation: 'HIGH_PRIORITY' });
    await seed({ externalId: 'b', url: 'https://x.test/b' }, { recommendation: 'APPLY' });
    await seed({ externalId: 'c', url: 'https://x.test/c' }, { recommendation: 'SKIP' });

    const body = await fetch(api('/api/jobs?recommendation=HIGH_PRIORITY,APPLY')).then((r) =>
      r.json(),
    );
    expect(body.count).toBe(2);
  });

  it('searches title, company and description', async () => {
    await seed({ externalId: 'a', url: 'https://x.test/a', company: 'Globex' });
    await seed({ externalId: 'b', url: 'https://x.test/b', company: 'Initech' });

    const body = await fetch(api('/api/jobs?search=globex')).then((r) => r.json());
    expect(body.count).toBe(1);
    expect(body.jobs[0].company).toBe('Globex');
  });

  it('treats regex characters in the search as literal text', async () => {
    await seed({ externalId: 'a', url: 'https://x.test/a', company: 'C++ Shop' });
    const body = await fetch(api('/api/jobs?search=' + encodeURIComponent('C++'))).then((r) =>
      r.json(),
    );
    expect(body.count).toBe(1);
  });

  it('filters by company', async () => {
    await seed({ externalId: 'a', url: 'https://x.test/a', company: 'Globex' });
    await seed({ externalId: 'b', url: 'https://x.test/b', company: 'Initech' });

    const body = await fetch(api('/api/jobs?company=Initech')).then((r) => r.json());
    expect(body.count).toBe(1);
  });

  it('hides dismissed and rejected jobs by default', async () => {
    const a = await seed({ externalId: 'a', url: 'https://x.test/a' });
    await seed({ externalId: 'b', url: 'https://x.test/b' });
    await dashRepo.updateApplication(a, { status: 'DISMISSED' });

    const hidden = await fetch(api('/api/jobs')).then((r) => r.json());
    expect(hidden.count).toBe(1);

    const shown = await fetch(api('/api/jobs?includeClosed=true')).then((r) => r.json());
    expect(shown.count).toBe(2);
  });

  it('filters by an explicit status even when that status is normally hidden', async () => {
    const a = await seed({ externalId: 'a', url: 'https://x.test/a' });
    await seed({ externalId: 'b', url: 'https://x.test/b' });
    await dashRepo.updateApplication(a, { status: 'DISMISSED' });

    const body = await fetch(api('/api/jobs?status=DISMISSED')).then((r) => r.json());
    expect(body.count).toBe(1);
  });

  it('respects a limit', async () => {
    for (const id of ['a', 'b', 'c']) {
      await seed({ externalId: id, url: `https://x.test/${id}` });
    }
    const body = await fetch(api('/api/jobs?limit=2')).then((r) => r.json());
    expect(body.count).toBe(2);
  });

  it('returns an empty list rather than failing when nothing is stored', async () => {
    const body = await fetch(api('/api/jobs')).then((r) => r.json());
    expect(body).toEqual({ jobs: [], count: 0 });
  });

  it('reports a job with no evaluation yet, rather than dropping it', async () => {
    await jobRepo.upsert(job());
    const body = await fetch(api('/api/jobs')).then((r) => r.json());
    expect(body.count).toBe(1);
    expect(body.jobs[0].score).toBeNull();
  });
});

describe('PATCH /api/jobs/:id/application', () => {
  it('saves a status and returns it on the next read', async () => {
    const id = await seed();

    const res = await fetch(api(`/api/jobs/${id}/application`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPLIED' }),
    });
    expect(res.status).toBe(200);

    const body = await fetch(api('/api/jobs')).then((r) => r.json());
    expect(body.jobs[0].status).toBe('APPLIED');
    expect(body.jobs[0].appliedAt).not.toBeNull();
  });

  it('appends every transition to the history', async () => {
    const id = await seed();
    await dashRepo.updateApplication(id, { status: 'INTERESTED' });
    await dashRepo.updateApplication(id, { status: 'APPLIED' });
    await dashRepo.updateApplication(id, { status: 'INTERVIEWING' });

    const row = firstRow<ApplicationRow>('SELECT * FROM job_applications WHERE job_id = ?', id);
    const history = JSON.parse(row!.status_history) as { status: string }[];
    expect(history.map((h) => h.status)).toEqual(['INTERESTED', 'APPLIED', 'INTERVIEWING']);
  });

  it('does not move appliedAt when the status changes again', async () => {
    const id = await seed();
    await dashRepo.updateApplication(id, { status: 'APPLIED' });
    const first = firstRow<ApplicationRow>('SELECT * FROM job_applications WHERE job_id = ?', id);

    await new Promise((r) => setTimeout(r, 10));
    await dashRepo.updateApplication(id, { status: 'INTERVIEWING' });
    const second = firstRow<ApplicationRow>('SELECT * FROM job_applications WHERE job_id = ?', id);

    expect(second?.applied_at).toBe(first?.applied_at);
    expect(second?.status).toBe('INTERVIEWING');
  });

  it('does not duplicate history when the same status is set twice', async () => {
    const id = await seed();
    await dashRepo.updateApplication(id, { status: 'APPLIED' });
    await dashRepo.updateApplication(id, { status: 'APPLIED' });

    const doc = firstRow<ApplicationRow>('SELECT * FROM job_applications WHERE job_id = ?', id);
    expect(JSON.parse(doc!.status_history)).toHaveLength(1);
  });

  it('round-trips notes', async () => {
    const id = await seed();
    await fetch(api(`/api/jobs/${id}/application`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Referred by a friend' }),
    });

    const body = await fetch(api('/api/jobs')).then((r) => r.json());
    expect(body.jobs[0].notes).toBe('Referred by a friend');
  });

  it('updating notes alone leaves the status untouched', async () => {
    const id = await seed();
    await dashRepo.updateApplication(id, { status: 'APPLIED' });
    await dashRepo.updateApplication(id, { notes: 'follow up Friday' });

    const doc = firstRow<ApplicationRow>('SELECT * FROM job_applications WHERE job_id = ?', id);
    expect(doc?.status).toBe('APPLIED');
    expect(doc?.notes).toBe('follow up Friday');
  });

  it('rejects an unknown status', async () => {
    const id = await seed();
    const res = await fetch(api(`/api/jobs/${id}/application`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'PROBABLY' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed body', async () => {
    const id = await seed();
    const res = await fetch(api(`/api/jobs/${id}/application`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('404s on a non-ObjectId path', async () => {
    const res = await fetch(api('/api/jobs/nonsense/application'), { method: 'PATCH' });
    expect(res.status).toBe(404);
  });
});

describe('application state survives the pipeline', () => {
  it('is not clobbered when the same job is re-scraped', async () => {
    const id = await seed();
    await dashRepo.updateApplication(id, { status: 'APPLIED', notes: 'sent CV' });

    // A later run re-scrapes the same posting with a changed description.
    await jobRepo.upsert(job({ description: 'Rewritten description with Kafka.' }));

    const body = await fetch(api('/api/jobs')).then((r) => r.json());
    expect(body.jobs[0].id).toBe(id);
    expect(body.jobs[0].status).toBe('APPLIED');
    expect(body.jobs[0].notes).toBe('sent CV');
  });
});

describe('GET /api/stats', () => {
  it('counts by recommendation and status, and reports the last run', async () => {
    const a = await seed({ externalId: 'a', url: 'https://x.test/a' }, { recommendation: 'APPLY' });
    await seed({ externalId: 'b', url: 'https://x.test/b' }, { recommendation: 'SKIP' });
    await dashRepo.updateApplication(a, { status: 'APPLIED' });

    const runs = new RunRepository();
    const runId = await runs.start(new Date());
    await runs.complete(runId, {
      ...EMPTY_RUN_STATS,
      jobsFetched: 653,
      cloudLLMRequests: 3,
      estimatedCloudCost: 0.01,
    });

    const stats = await fetch(api('/api/stats')).then((r) => r.json());
    expect(stats.total).toBe(2);
    expect(stats.byRecommendation.APPLY).toBe(1);
    expect(stats.byRecommendation.SKIP).toBe(1);
    expect(stats.byStatus.APPLIED).toBe(1);
    expect(stats.byStatus.NEW).toBe(1);
    expect(stats.lastRun.jobsFetched).toBe(653);
    expect(stats.lastRun.cloudRequests).toBe(3);
    expect(stats.companies).toContain('Acme Corp');
  });

  it('works with an empty database', async () => {
    const stats = await fetch(api('/api/stats')).then((r) => r.json());
    expect(stats.total).toBe(0);
    expect(stats.lastRun).toBeNull();
  });
});

describe('static assets and safety', () => {
  it('serves the dashboard page', async () => {
    const res = await fetch(api('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Job&nbsp;Finder');
  });

  it('serves the stylesheets', async () => {
    expect((await fetch(api('/app.css'))).status).toBe(200);
    expect((await fetch(api('/views.css'))).status).toBe(200);
  });

  it('serves the module entry point and its imports from subdirectories', async () => {
    const entry = await fetch(api('/js/main.js'));
    expect(entry.status).toBe(200);
    expect(entry.headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(api('/js/core/router.js'))).status).toBe(200);
    expect((await fetch(api('/js/views/jobs.js'))).status).toBe(200);
  });

  it('refuses to climb out of public/ from a subdirectory', async () => {
    const res = await fetch(api('/js/../../.env'), { redirect: 'manual' });
    expect(res.status).not.toBe(200);
  });

  it('refuses to serve files outside the public directory', async () => {
    const res = await fetch(api('/../../.env'), { redirect: 'manual' });
    expect(res.status).not.toBe(200);
  });

  it('404s an unknown path', async () => {
    expect((await fetch(api('/nope.txt'))).status).toBe(404);
  });

  it('answers the health check', async () => {
    expect(await fetch(api('/api/health')).then((r) => r.json())).toEqual({ ok: true });
  });

  it('binds loopback only', () => {
    const address = harness.dashboard.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
  });
});

describe('query parsing', () => {
  it('reads every supported filter', () => {
    const filters = filtersFromQuery(
      new URLSearchParams(
        'minScore=70&maxScore=95&recommendation=APPLY,SKIP&status=NEW&source=mock' +
          '&company=Acme&search=node&newOnly=true&includeClosed=true&sort=posted&days=7&limit=10',
      ),
    );
    expect(filters).toMatchObject({
      minScore: 70,
      maxScore: 95,
      recommendation: ['APPLY', 'SKIP'],
      status: ['NEW'],
      source: ['mock'],
      company: 'Acme',
      search: 'node',
      newOnly: true,
      includeClosed: true,
      sort: 'posted',
      days: 7,
      limit: 10,
    });
  });

  it('ignores junk values instead of throwing', () => {
    const filters = filtersFromQuery(new URLSearchParams('minScore=abc&sort=sideways'));
    expect(filters.minScore).toBeUndefined();
    expect(filters.sort).toBeUndefined();
  });
});

describe('request dispatch', () => {
  it('answers 405, not 404, when the path exists but the method does not', async () => {
    const res = await fetch(api('/api/stats'), { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('GET');
  });

  it('still 404s a path that does not exist at all', async () => {
    expect((await fetch(api('/api/nope'), { method: 'POST' })).status).toBe(404);
  });

  it('answers 413, not 500, when a body is too large', async () => {
    const id = await seed();
    const res = await fetch(api(`/api/jobs/${id}/application`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'x'.repeat(1_100_000) }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects a mutating request from another origin', async () => {
    const id = await seed();
    const res = await fetch(api(`/api/jobs/${id}/application`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ status: 'APPLIED' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows a mutating request from the dashboard itself', async () => {
    const id = await seed();
    const res = await fetch(api(`/api/jobs/${id}/application`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: harness.dashboard.url },
      body: JSON.stringify({ status: 'APPLIED' }),
    });
    expect(res.status).toBe(200);
  });

  it('leaves reads open to any origin', async () => {
    const res = await fetch(api('/api/stats'), { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
  });
});
