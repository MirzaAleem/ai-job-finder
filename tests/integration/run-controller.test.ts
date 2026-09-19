import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTables, startTestDb, stopTestDb } from '../helpers/db.js';
import { createRunController, type RunEvent } from '../../src/dashboard/run-controller.js';
import { createConfigStore } from '../../src/dashboard/config-store.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { loadEnv } from '../../src/config/env.js';
import { createTempWorkspace, type TempWorkspace } from '../helpers/workspace.js';

const PROFILE = `targetRoles:
  - Backend Engineer
  - Software Engineer
yearsOfExperience: 6
`;

let workspace: TempWorkspace;

beforeAll(() => startTestDb());
afterAll(() => stopTestDb());

beforeEach(async () => {
  await clearTables();
  workspace = await createTempWorkspace({ profile: PROFILE, env: 'SOURCES_ENABLED=mock\n' });
});
afterEach(() => workspace.cleanup());

async function controller(overrides: Record<string, string> = {}) {
  const config = await createConfigStore({
    envPath: workspace.envPath,
    fallback: loadEnv({} as NodeJS.ProcessEnv),
    logger: createSilentLogger(),
    baseEnv: { SOURCES_ENABLED: 'mock', OLLAMA_BASE_URL: 'http://127.0.0.1:1', ...overrides },
  });
  await config.reload();
  return createRunController({
    config,
    logger: createSilentLogger(),
    profileFile: () => workspace.profilePath,
  });
}

/** Wait for the controller to go idle again. */
async function settle(runner: { state(): { running: boolean } }): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (!runner.state().running) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the run never finished');
}

describe('run controller', () => {
  it('starts idle', async () => {
    const runner = await controller();
    expect(runner.state()).toMatchObject({ running: false, runId: null });
  });

  it('refuses a second run while one is in flight', async () => {
    const runner = await controller();
    expect(runner.start({}).started).toBe(true);

    const second = runner.start({});
    expect(second.started).toBe(false);
    expect(second.reason).toContain('already in progress');

    await settle(runner);
  });

  it('rejects an unknown source before starting anything', async () => {
    const runner = await controller();
    const result = runner.start({ sources: ['linkedin'] });
    expect(result.started).toBe(false);
    expect(result.reason).toContain('linkedin');
    expect(runner.state().running).toBe(false);
  });

  it('refuses to start when no source is enabled', async () => {
    // .env wins over the base environment, so the empty value has to go there.
    await workspace.write('.env', 'SOURCES_ENABLED=\n');
    const runner = await controller();
    const result = runner.start({});
    expect(result.started).toBe(false);
    expect(result.reason).toContain('no sources');
  });

  it('reports a missing profile in words a person can act on', async () => {
    const runner = await controller();
    await workspace.cleanup();
    workspace = await createTempWorkspace({ env: 'SOURCES_ENABLED=mock\n' });

    const events: RunEvent[] = [];
    runner.subscribe((event) => events.push(event));
    runner.start({});
    await settle(runner);

    const failure = events.find((e) => e.type === 'error');
    expect((failure?.data as { message: string }).message).toContain('Profile');
  });

  it('runs end to end and reports stages, logs and a summary', async () => {
    const runner = await controller();
    const events: RunEvent[] = [];
    runner.subscribe((event) => events.push(event));

    // Ollama is unreachable here, so evaluation degrades — the pipeline still
    // completes, which is what makes this safe to run in the suite.
    runner.start({ sources: ['mock'], noCloud: true, skipExport: true });
    await settle(runner);

    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(events.some((e) => e.type === 'log')).toBe(true);
    expect(events.some((e) => e.type === 'summary')).toBe(true);
    expect(runner.state().runId).toBeTruthy();
  });

  it('keeps the heavy ranked array out of the stored summary', async () => {
    const runner = await controller();
    runner.start({ sources: ['mock'], skipExport: true });
    await settle(runner);

    const summary = runner.state().lastSummary;
    expect(summary).toBeTruthy();
    expect(summary).not.toHaveProperty('ranked');
    // A poll of /api/runs/current must stay small; `ranked` carries every
    // job description and would be kilobytes on every reconnect.
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
  });

  it('numbers events so a reconnect can replay only what it missed', async () => {
    const runner = await controller();
    runner.start({ sources: ['mock'], skipExport: true });
    await settle(runner);

    const all = runner.events();
    expect(all.length).toBeGreaterThan(2);
    expect(all.map((e) => e.seq)).toEqual([...all].sort((a, b) => a.seq - b.seq).map((e) => e.seq));

    const tail = runner.events(all[0]!.seq);
    expect(tail).toHaveLength(all.length - 1);
  });

  it('clears the buffer when a new run starts', async () => {
    const runner = await controller();
    runner.start({ sources: ['mock'], skipExport: true });
    await settle(runner);
    const first = runner.events().length;
    expect(first).toBeGreaterThan(0);

    runner.start({ sources: ['mock'], skipExport: true });
    expect(runner.events().length).toBeLessThan(first);
    await settle(runner);
  });

  it('has nothing to cancel when idle', async () => {
    const runner = await controller();
    expect(runner.cancel()).toBe(false);
  });

  it('does not write per-run overrides back to settings', async () => {
    const runner = await controller();
    runner.start({ sources: ['mock'], noCloud: true, skipExport: true });
    await settle(runner);

    const onDisk = await workspace.read('.env');
    expect(onDisk).toContain('SOURCES_ENABLED=mock');
    expect(onDisk).not.toContain('CLOUD_ESCALATION_ENABLED');
  });
});
