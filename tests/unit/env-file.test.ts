import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  applyEnvEdits,
  parseEnvFile,
  parseValue,
  serialiseValue,
  updateEnvFile,
} from '../../src/config/env-file.js';
import { createTempWorkspace, type TempWorkspace } from '../helpers/workspace.js';

const SAMPLE = `# Copy to .env and edit
# .env is gitignored. Never commit real keys.

NODE_ENV=development

# ---- LOCAL LLM ----
# Any installed Ollama model.
OLLAMA_MODEL=llama3.1:8b
OLLAMA_TIMEOUT_MS=300000

OPENROUTER_API_KEY=
`;

describe('applyEnvEdits', () => {
  it('replaces a value in place', () => {
    const next = applyEnvEdits(SAMPLE, { OLLAMA_MODEL: 'qwen3:8b' });
    expect(next).toContain('OLLAMA_MODEL=qwen3:8b');
    expect(next).not.toContain('llama3.1:8b');
  });

  it('preserves every comment and blank line', () => {
    const next = applyEnvEdits(SAMPLE, { OLLAMA_MODEL: 'qwen3:8b' });
    expect(next).toContain('# Copy to .env and edit');
    expect(next).toContain('# ---- LOCAL LLM ----');
    expect(next).toContain('# Any installed Ollama model.');
    // Same number of lines: one was edited, none added or removed.
    expect(next.split('\n')).toHaveLength(SAMPLE.split('\n').length);
  });

  it('preserves the order of unrelated keys', () => {
    const next = applyEnvEdits(SAMPLE, { OLLAMA_TIMEOUT_MS: '600000' });
    const keys = next
      .split('\n')
      .filter((l) => /^[A-Z]/.test(l))
      .map((l) => l.split('=')[0]);
    expect(keys).toEqual(['NODE_ENV', 'OLLAMA_MODEL', 'OLLAMA_TIMEOUT_MS', 'OPENROUTER_API_KEY']);
  });

  it('appends a genuinely new key under a header', () => {
    const next = applyEnvEdits(SAMPLE, { DASHBOARD_PORT: '8080' });
    expect(next).toContain('# Added by the dashboard');
    expect(next).toContain('DASHBOARD_PORT=8080');
    expect(next.indexOf('# Added by the dashboard')).toBeLessThan(next.indexOf('DASHBOARD_PORT'));
  });

  it('does not repeat the header on a second append', () => {
    const once = applyEnvEdits(SAMPLE, { DASHBOARD_PORT: '8080' });
    const twice = applyEnvEdits(once, { SEARCH_QUERIES: 'backend' });
    expect(twice.match(/# Added by the dashboard/g)).toHaveLength(1);
  });

  it('deletes a line when the value is null', () => {
    const next = applyEnvEdits(SAMPLE, { OLLAMA_TIMEOUT_MS: null });
    expect(next).not.toContain('OLLAMA_TIMEOUT_MS');
    expect(next).toContain('OLLAMA_MODEL=llama3.1:8b');
  });

  it('is idempotent — editing to the same value changes nothing', () => {
    const once = applyEnvEdits(SAMPLE, { OLLAMA_MODEL: 'qwen3:8b' });
    expect(applyEnvEdits(once, { OLLAMA_MODEL: 'qwen3:8b' })).toBe(once);
  });

  it('returns the input untouched when there is nothing to do', () => {
    expect(applyEnvEdits(SAMPLE, {})).toBe(SAMPLE);
  });

  it('writes an empty value without quoting it', () => {
    expect(applyEnvEdits(SAMPLE, { OPENROUTER_API_KEY: '' })).toContain('OPENROUTER_API_KEY=\n');
  });

  it('keeps a trailing newline', () => {
    expect(applyEnvEdits(SAMPLE, { NODE_ENV: 'production' }).endsWith('\n')).toBe(true);
  });

  it('builds a file from nothing', () => {
    expect(applyEnvEdits('', { OLLAMA_MODEL: 'qwen3:8b' })).toContain('OLLAMA_MODEL=qwen3:8b');
  });

  it('keeps the original indentation of an indented key', () => {
    expect(applyEnvEdits('  FOO=1\n', { FOO: '2' })).toBe('  FOO=2\n');
  });

  it('matches a key written with an export prefix', () => {
    expect(applyEnvEdits('export FOO=1\n', { FOO: '2' })).toContain('FOO=2');
  });

  it('does not match a key that is merely a prefix of another', () => {
    const next = applyEnvEdits('OLLAMA_MODEL=a\nOLLAMA_MODEL_EXTRA=b\n', { OLLAMA_MODEL: 'z' });
    expect(next).toContain('OLLAMA_MODEL=z');
    expect(next).toContain('OLLAMA_MODEL_EXTRA=b');
  });

  it('never edits a key that only appears inside a comment', () => {
    const next = applyEnvEdits('# OLLAMA_MODEL=commented\nFOO=1\n', { OLLAMA_MODEL: 'z' });
    expect(next).toContain('# OLLAMA_MODEL=commented');
    expect(next).toContain('OLLAMA_MODEL=z');
  });
});

describe('value quoting', () => {
  it.each([
    ['0 8 * * *', '"0 8 * * *"'],
    ['plain', 'plain'],
    ['', ''],
    ['has#hash', '"has#hash"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\slash', '"back\\\\slash"'],
  ])('serialises %j', (input, expected) => {
    expect(serialiseValue(input)).toBe(expected);
  });

  it.each(['0 8 * * *', 'plain', 'has#hash', 'say "hi"', 'back\\slash', 'sk-or-v1-abc'])(
    'round-trips %j',
    (value) => {
      expect(parseValue(serialiseValue(value))).toBe(value);
    },
  );

  it('round-trips a cron expression through a whole file', () => {
    const next = applyEnvEdits('JOB_RUN_CRON=x\n', { JOB_RUN_CRON: '0 8 * * *' });
    expect(parseEnvFile(next).JOB_RUN_CRON).toBe('0 8 * * *');
  });
});

describe('parseEnvFile', () => {
  it('reads keys and skips comments and blanks', () => {
    expect(parseEnvFile(SAMPLE)).toEqual({
      NODE_ENV: 'development',
      OLLAMA_MODEL: 'llama3.1:8b',
      OLLAMA_TIMEOUT_MS: '300000',
      OPENROUTER_API_KEY: '',
    });
  });

  it('strips an inline comment from an unquoted value', () => {
    expect(parseEnvFile('FOO=bar # why\n').FOO).toBe('bar');
  });

  it('keeps a hash inside a quoted value', () => {
    expect(parseEnvFile('FOO="bar # why"\n').FOO).toBe('bar # why');
  });

  it('strips single quotes without unescaping', () => {
    expect(parseEnvFile("FOO='a\\nb'\n").FOO).toBe('a\\nb');
  });
});

describe('updateEnvFile', () => {
  let workspace: TempWorkspace;
  afterEach(() => workspace?.cleanup());

  it('writes atomically and leaves no temp file behind', async () => {
    workspace = await createTempWorkspace({ env: SAMPLE });
    await updateEnvFile(workspace.envPath, { OLLAMA_MODEL: 'qwen3:8b' });

    expect(await readFile(workspace.envPath, 'utf8')).toContain('OLLAMA_MODEL=qwen3:8b');
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(workspace.root)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('creates the file when it does not exist yet', async () => {
    workspace = await createTempWorkspace();
    await updateEnvFile(workspace.envPath, { OLLAMA_MODEL: 'qwen3:8b' });
    expect(await workspace.read('.env')).toContain('OLLAMA_MODEL=qwen3:8b');
  });

  it('returns the values as they now stand on disk', async () => {
    workspace = await createTempWorkspace({ env: SAMPLE });
    const values = await updateEnvFile(workspace.envPath, { OLLAMA_MODEL: 'qwen3:8b' });
    expect(values.OLLAMA_MODEL).toBe('qwen3:8b');
    expect(values.NODE_ENV).toBe('development');
  });
});
