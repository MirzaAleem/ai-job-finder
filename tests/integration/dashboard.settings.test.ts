import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestDashboard, type TestDashboard } from '../helpers/dashboard.js';

const ENV = `# Job Finder configuration
# Never commit real keys.

NODE_ENV=development

# ---- LOCAL LLM ----
# Any installed Ollama model.
OLLAMA_MODEL=llama3.1:8b

SCORE_APPLY=80
`;

let harness: TestDashboard;

beforeEach(async () => {
  harness = await startTestDashboard({ env: ENV });
});
afterEach(() => harness.close());

const get = () => fetch(harness.api('/api/settings')).then((r) => r.json());

const put = (values: Record<string, string>) =>
  fetch(harness.api('/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });

describe('GET /api/settings', () => {
  it('returns the catalogue, the groups and the current values', async () => {
    const body = await get();
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.fields.length).toBeGreaterThan(20);
    expect(body.values.OLLAMA_MODEL.value).toBe('llama3.1:8b');
    expect(body.envPath).toBe(harness.workspace.envPath);
  });

  it('marks a key the file does not mention as still on its default', async () => {
    const body = await get();
    expect(body.values.OLLAMA_MODEL.isDefault).toBe(false);
    expect(body.values.LLM_BATCH_SIZE.isDefault).toBe(true);
    expect(body.values.LLM_BATCH_SIZE.value).toBe('5');
  });

  it('reports the default alongside the current value', async () => {
    const body = await get();
    expect(body.values.OLLAMA_MODEL.default).toBe('llama3.1:8b');
    expect(body.values.SCORE_APPLY.default).toBe('80');
  });

  it('starts with nothing pending a restart', async () => {
    expect((await get()).restartPending).toEqual([]);
  });
});

describe('PUT /api/settings', () => {
  it('saves a value and reflects it on the next read', async () => {
    expect((await put({ OLLAMA_MODEL: 'qwen3:8b' })).status).toBe(200);
    expect((await get()).values.OLLAMA_MODEL.value).toBe('qwen3:8b');
  });

  it('writes the value through to .env', async () => {
    await put({ SCORE_APPLY: '85' });
    expect(await harness.workspace.read('.env')).toContain('SCORE_APPLY=85');
  });

  it('leaves the comments in .env intact', async () => {
    await put({ OLLAMA_MODEL: 'qwen3:8b' });
    const contents = await harness.workspace.read('.env');
    expect(contents).toContain('# Job Finder configuration');
    expect(contents).toContain('# ---- LOCAL LLM ----');
    expect(contents).toContain('# Any installed Ollama model.');
  });

  it('leaves unrelated keys alone', async () => {
    await put({ OLLAMA_MODEL: 'qwen3:8b' });
    expect(await harness.workspace.read('.env')).toContain('SCORE_APPLY=80');
  });

  it('accepts a partial update of one group at a time', async () => {
    await put({ SCORE_HIGH_PRIORITY: '92' });
    await put({ LLM_BATCH_SIZE: '8' });
    const body = await get();
    expect(body.values.SCORE_HIGH_PRIORITY.value).toBe('92');
    expect(body.values.LLM_BATCH_SIZE.value).toBe('8');
  });

  it('applies the change to the live config, not just the file', async () => {
    await put({ OLLAMA_MODEL: 'qwen3:8b' });
    expect(harness.config.current().OLLAMA_MODEL).toBe('qwen3:8b');
  });

  it('names the keys that need a restart', async () => {
    const res = await put({ SQLITE_PATH: 'data/other.db' });
    expect(res.status).toBe(200);
    expect((await res.json()).restartRequired).toEqual(['SQLITE_PATH']);
  });

  it('reports a pending restart on later reads', async () => {
    await put({ DASHBOARD_PORT: '9999' });
    expect((await get()).restartPending).toEqual(['DASHBOARD_PORT']);
  });

  it('rejects a key that is not a setting', async () => {
    const res = await put({ TOTALLY_MADE_UP: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).fields[0].path).toBe('TOTALLY_MADE_UP');
  });

  it('refuses a key another view owns', async () => {
    const res = await put({ SOURCES_ENABLED: 'mock' });
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0]).toContain('Sources');
  });

  it('rejects a value the schema will not accept', async () => {
    const res = await put({ SCORE_APPLY: 'eighty' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid settings');
    expect(body.fields.some((f: { path: string }) => f.path === 'SCORE_APPLY')).toBe(true);
  });

  it('rejects a value outside an enum', async () => {
    expect((await put({ CLOUD_PROVIDER: 'chatgpt' })).status).toBe(400);
  });

  it('never writes a rejected value to disk', async () => {
    await put({ SCORE_APPLY: 'eighty' });
    const contents = await harness.workspace.read('.env');
    expect(contents).toContain('SCORE_APPLY=80');
    expect(contents).not.toContain('eighty');
  });

  it('leaves the live config untouched after a rejected save', async () => {
    await put({ SCORE_APPLY: 'eighty' });
    expect(harness.config.current().SCORE_APPLY).toBe(80);
  });

  it('rejects a body that is not shaped like an update', async () => {
    const res = await fetch(harness.api('/api/settings'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });

  it('quotes a value that needs it, so it survives a round trip', async () => {
    await put({ JOB_RUN_CRON: '30 7 * * 1-5' });
    expect(await harness.workspace.read('.env')).toContain('JOB_RUN_CRON="30 7 * * 1-5"');
    expect((await get()).values.JOB_RUN_CRON.value).toBe('30 7 * * 1-5');
  });

  it('stores an API key as typed', async () => {
    await put({ OPENROUTER_API_KEY: 'sk-or-v1-testkey123' });
    expect((await get()).values.OPENROUTER_API_KEY.value).toBe('sk-or-v1-testkey123');
  });
});

describe('provider probes', () => {
  it('reports cloud escalation as unavailable without a key', async () => {
    const body = await fetch(harness.api('/api/settings/test-providers'), {
      method: 'POST',
    }).then((r) => r.json());
    expect(body.cloud.ok).toBe(false);
    expect(body.cloud.message).toContain('local-only');
  });

  it('reports the local model rather than failing when Ollama is unreachable', async () => {
    const res = await fetch(harness.api('/api/settings/test-providers'), { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).local.ok).toBe(false);
  });

  it('answers the model list even when Ollama is down', async () => {
    const res = await fetch(harness.api('/api/models'));
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([]);
  });
});
