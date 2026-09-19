import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTables, startTestDb, stopTestDb } from '../helpers/db.js';
import { startTestDashboard, type TestDashboard } from '../helpers/dashboard.js';
import { createFakeRunner, type FakeRunner } from '../helpers/fake-runner.js';
import { RunRepository } from '../../src/db/run.repository.js';

let harness: TestDashboard;
let runner: FakeRunner;
const runs = new RunRepository();

beforeAll(() => startTestDb());
afterAll(() => stopTestDb());

beforeEach(async () => {
  await clearTables();
  runner = createFakeRunner();
  harness = await startTestDashboard({ runner });
});
afterEach(() => harness.close());

const post = (route: string, body?: unknown) =>
  fetch(harness.api(route), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

/** Seed a completed run row with sensible defaults. */
async function seedRun(overrides: Partial<Parameters<RunRepository['complete']>[1]> = {}) {
  const id = await runs.start(new Date());
  await runs.complete(id, {
    sourceCounts: { mock: 25 },
    jobsFetched: 25,
    jobsDeduplicated: 24,
    jobsFiltered: 12,
    jobsEvaluated: 12,
    jobsFromCache: 2,
    jobsNew: 10,
    localLLMRequests: 3,
    cloudLLMRequests: 1,
    cloudInputTokens: 900,
    cloudOutputTokens: 120,
    estimatedCloudCost: 0.0042,
    escalationReasonCounts: { 'Low confidence': 1 },
    highPriorityCount: 2,
    applyCount: 3,
    considerCount: 4,
    skipCount: 3,
    outputFiles: ['output/jobs-2026-09-12.csv'],
    errors: [],
    ...overrides,
  });
  return id;
}

describe('POST /api/runs', () => {
  it('accepts a run and returns immediately', async () => {
    const res = await post('/api/runs', { sources: ['mock'] });
    expect(res.status).toBe(202);
    expect((await res.json()).started).toBe(true);
    expect(runner.started).toEqual([{ sources: ['mock'] }]);
  });

  it('passes the per-run overrides through', async () => {
    await post('/api/runs', { sources: ['mock'], noCloud: true, dryRun: true });
    expect(runner.started[0]).toEqual({ sources: ['mock'], noCloud: true, dryRun: true });
  });

  it('refuses a second run while one is in flight', async () => {
    runner.allowStart = false;
    const res = await post('/api/runs', {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('already in progress');
  });

  it('rejects a source name the pipeline does not know', async () => {
    const res = await post('/api/runs', { sources: ['linkedin'] });
    expect(res.status).toBe(400);
    expect(runner.started).toEqual([]);
  });

  it('rejects a malformed body', async () => {
    const res = await post('/api/runs', { noCloud: 'yes please' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/runs/cancel', () => {
  it('cancels a run that is in flight', async () => {
    await post('/api/runs', {});
    expect((await post('/api/runs/cancel')).status).toBe(200);
    expect(runner.cancelled).toBe(1);
  });

  it('409s when there is nothing to cancel', async () => {
    expect((await post('/api/runs/cancel')).status).toBe(409);
  });
});

describe('GET /api/runs/current', () => {
  it('reports an idle controller', async () => {
    const body = await fetch(harness.api('/api/runs/current')).then((r) => r.json());
    expect(body.running).toBe(false);
  });

  it('lets a reloaded page discover a run already in progress', async () => {
    await post('/api/runs', {});
    const body = await fetch(harness.api('/api/runs/current')).then((r) => r.json());
    expect(body.running).toBe(true);
    expect(body.startedAt).toBeTruthy();
  });
});

describe('GET /api/runs/events', () => {
  it('replays buffered events so a reconnect loses nothing', async () => {
    runner.push('log', { message: 'first' });
    runner.push('log', { message: 'second' });

    const all = await fetch(harness.api('/api/runs/events')).then((r) => r.json());
    expect(all.events).toHaveLength(2);

    const after = await fetch(harness.api('/api/runs/events?after=1')).then((r) => r.json());
    expect(after.events).toHaveLength(1);
    expect(after.events[0].data.message).toBe('second');
  });
});

describe('GET /api/runs/stream', () => {
  it('streams events as they happen', async () => {
    const response = await fetch(harness.api('/api/runs/stream'));
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    runner.push('progress', { stage: 'fetching', message: 'Fetching jobs' });

    let seen = '';
    while (!seen.includes('event: progress')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }

    expect(seen).toContain('event: progress');
    expect(seen).toContain('Fetching jobs');
    // The id: line is what lets EventSource resume with Last-Event-ID.
    expect(seen).toMatch(/id: \d+/);

    await reader.cancel();
  });

  it('replays what a reconnecting client missed', async () => {
    runner.push('log', { message: 'before the reconnect' });
    runner.push('log', { message: 'also before' });

    const response = await fetch(harness.api('/api/runs/stream'), {
      headers: { 'Last-Event-ID': '1' },
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    let seen = '';
    while (!seen.includes('also before')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }

    expect(seen).toContain('also before');
    expect(seen).not.toContain('before the reconnect');
    await reader.cancel();
  });

  it('shuts the server down cleanly with a stream still open', async () => {
    // Without SseHub.closeAll() the socket stays alive, server.close() never
    // calls back, and both Ctrl-C and this test hang forever.
    const response = await fetch(harness.api('/api/runs/stream'));
    const reader = response.body!.getReader();
    await reader.read();

    const closed = await Promise.race([
      harness.dashboard.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 4000)),
    ]);

    expect(closed).toBe('closed');
    await reader.cancel().catch(() => undefined);
    await harness.workspace.cleanup();
    harness = await startTestDashboard({ runner });
  });
});

describe('GET /api/runs', () => {
  it('returns an empty history', async () => {
    const body = await fetch(harness.api('/api/runs')).then((r) => r.json());
    expect(body).toMatchObject({ runs: [], total: 0 });
  });

  it('maps a row into a clean view', async () => {
    await seedRun();
    const body = await fetch(harness.api('/api/runs')).then((r) => r.json());

    expect(body.total).toBe(1);
    expect(body.runs[0]).toMatchObject({
      status: 'COMPLETED',
      jobsFetched: 25,
      jobsNew: 10,
      cloudRequests: 1,
      counts: { HIGH_PRIORITY: 2, APPLY: 3, CONSIDER: 4, SKIP: 3 },
      outputFiles: ['output/jobs-2026-09-12.csv'],
    });
    expect(body.runs[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns newest first', async () => {
    const first = await seedRun();
    const second = await seedRun();
    const body = await fetch(harness.api('/api/runs')).then((r) => r.json());
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual([second, first]);
  });

  it('paginates', async () => {
    await seedRun();
    await seedRun();
    await seedRun();

    const page = await fetch(harness.api('/api/runs?limit=2&offset=1')).then((r) => r.json());
    expect(page.runs).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('filters by status', async () => {
    await seedRun();
    await runs.start(new Date()); // left RUNNING

    const done = await fetch(harness.api('/api/runs?status=COMPLETED')).then((r) => r.json());
    expect(done.total).toBe(1);
    expect(done.runs[0].status).toBe('COMPLETED');
  });

  it('ignores a junk status instead of failing', async () => {
    await seedRun();
    const body = await fetch(harness.api('/api/runs?status=sideways')).then((r) => r.json());
    expect(body.total).toBe(1);
  });

  it('clamps an absurd limit', async () => {
    await seedRun();
    const body = await fetch(harness.api('/api/runs?limit=99999')).then((r) => r.json());
    expect(body.runs).toHaveLength(1);
  });
});

describe('GET /api/runs/:id', () => {
  it('returns the detail view', async () => {
    const id = await seedRun();
    const body = await fetch(harness.api(`/api/runs/${id}`)).then((r) => r.json());

    expect(body.run).toMatchObject({
      id,
      jobsFiltered: 12,
      sourceCounts: { mock: 25 },
      escalationReasonCounts: { 'Low confidence': 1 },
      errors: [],
    });
  });

  it('404s an unknown id', async () => {
    expect((await fetch(harness.api('/api/runs/999999'))).status).toBe(404);
  });

  it('404s a non-numeric id rather than matching loosely', async () => {
    expect((await fetch(harness.api('/api/runs/nonsense'))).status).toBe(404);
  });
});
