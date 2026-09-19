import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import {
  issuesToFields,
  issuesToStrings,
  isAllowedOrigin,
  readJsonBody,
  resolveWithin,
} from '../../src/dashboard/http.js';

/** A request whose body is the given string, which is all readJsonBody reads. */
function request(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
}

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    expect(await readJsonBody(request('{"status":"APPLIED"}'))).toEqual({
      ok: true,
      value: { status: 'APPLIED' },
    });
  });

  it('treats an empty body as an empty object', async () => {
    expect(await readJsonBody(request(''))).toEqual({ ok: true, value: {} });
  });

  it('reports malformed JSON as a 400 rather than throwing', async () => {
    const result = await readJsonBody(request('not json'));
    expect(result).toEqual({ ok: false, status: 400, error: 'body must be valid JSON' });
  });

  it('reports an oversized body as a 413, not a 500', async () => {
    const result = await readJsonBody(request('x'.repeat(500)), 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });
});

describe('issuesToFields', () => {
  it('joins a nested path with dots so the client can find the input', () => {
    const parsed = z.object({ salary: z.object({ minimum: z.number() }) }).safeParse({
      salary: { minimum: 'lots' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(issuesToFields(parsed.error.issues)[0]?.path).toBe('salary.minimum');
    }
  });

  it('renders an array index as part of the path', () => {
    const parsed = z.object({ roles: z.array(z.string()) }).safeParse({ roles: ['ok', 7] });
    if (!parsed.success) {
      expect(issuesToFields(parsed.error.issues)[0]?.path).toBe('roles.1');
    }
  });

  it('leaves a root-level issue with an empty path', () => {
    const parsed = z.object({ a: z.string() }).strict().safeParse('nope');
    if (!parsed.success) {
      expect(issuesToFields(parsed.error.issues)[0]?.path).toBe('');
    }
  });

  it('formats strings the way the old inline handler did', () => {
    const parsed = z.object({ status: z.enum(['NEW']) }).safeParse({ status: 'PROBABLY' });
    if (!parsed.success) {
      expect(issuesToStrings(parsed.error.issues)[0]).toMatch(/^status: /);
    }
  });
});

describe('resolveWithin', () => {
  const root = path.resolve('/tmp/jobfinder-root');

  it('resolves a plain relative path', () => {
    expect(resolveWithin(root, 'app.css')).toBe(path.join(root, 'app.css'));
  });

  it('resolves a nested path', () => {
    expect(resolveWithin(root, 'js/views/run.js')).toBe(path.join(root, 'js/views/run.js'));
  });

  it('refuses a traversal escape', () => {
    expect(resolveWithin(root, '../../.env')).toBeNull();
  });

  it('refuses an absolute path outside the root', () => {
    expect(resolveWithin(root, '/etc/passwd')).toBeNull();
  });

  it('refuses the root itself', () => {
    expect(resolveWithin(root, '.')).toBeNull();
  });

  it('refuses a sibling whose name merely starts with the root name', () => {
    expect(resolveWithin(root, '../jobfinder-root-evil/x')).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  it('allows a request with no Origin header, as curl sends', () => {
    expect(isAllowedOrigin(undefined, 4321)).toBe(true);
  });

  it('allows the dashboard talking to itself', () => {
    expect(isAllowedOrigin('http://127.0.0.1:4321', 4321)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4321', 4321)).toBe(true);
  });

  it('rejects another site', () => {
    expect(isAllowedOrigin('https://example.com', 4321)).toBe(false);
  });

  it('rejects the right host on the wrong port', () => {
    expect(isAllowedOrigin('http://127.0.0.1:9999', 4321)).toBe(false);
  });
});
