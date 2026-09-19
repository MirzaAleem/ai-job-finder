import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

/** Loopback only. This serves personal job-search data with no authentication. */
export const BIND_HOST = '127.0.0.1';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Everything a route handler needs. `params` holds the path captures. */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Always-fresh data; the page is a live view of the database.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export const DEFAULT_BODY_LIMIT = 1_000_000;

export async function readBody(
  req: IncomingMessage,
  limitBytes = DEFAULT_BODY_LIMIT,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new BodyTooLargeError(limitBytes);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body too large (limit ${limitBytes} bytes)`);
    this.name = 'BodyTooLargeError';
  }
}

export type JsonBodyResult =
  { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string };

/**
 * Read and JSON-parse a request body without throwing.
 *
 * An oversized body is a 413, not the 500 it used to become when readBody's
 * throw escaped all the way to the server's generic error funnel.
 */
export async function readJsonBody(
  req: IncomingMessage,
  limitBytes = DEFAULT_BODY_LIMIT,
): Promise<JsonBodyResult> {
  let raw: string;
  try {
    raw = await readBody(req, limitBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return { ok: false, status: 413, error: err.message };
    }
    throw err;
  }

  try {
    return { ok: true, value: JSON.parse(raw || '{}') };
  } catch {
    return { ok: false, status: 400, error: 'body must be valid JSON' };
  }
}

/** The shape of a Zod issue that this module depends on, and nothing more. */
export interface ValidationIssue {
  path: readonly PropertyKey[];
  message: string;
}

interface ValidatorSuccess<T> {
  success: true;
  data: T;
}
interface ValidatorFailure {
  success: false;
  error: { issues: readonly ValidationIssue[] };
}

/** Structurally satisfied by any Zod schema. */
export interface Validator<T> {
  safeParse(value: unknown): ValidatorSuccess<T> | ValidatorFailure;
}

/** `salary.minimum` — the dot path the client uses to find the offending input. */
export function issuesToFields(
  issues: readonly ValidationIssue[],
): { path: string; message: string }[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

export function issuesToStrings(issues: readonly ValidationIssue[]): string[] {
  return issuesToFields(issues).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
}

/**
 * Read a JSON body, validate it, and hand the parsed value to `fn`.
 *
 * Every mutating endpoint funnels through here so they all fail identically:
 * 413 for an oversized body, 400 for unparseable JSON, 400 with per-field
 * issues for a schema violation.
 */
export function handleJson<T>(
  schema: Validator<T>,
  fn: (body: T, ctx: RouteContext) => Promise<unknown>,
  options: { errorLabel?: string; limitBytes?: number } = {},
): (ctx: RouteContext) => Promise<void> {
  const label = options.errorLabel ?? 'request';

  return async (ctx) => {
    const body = await readJsonBody(ctx.req, options.limitBytes);
    if (!body.ok) {
      sendJson(ctx.res, body.status, { error: body.error });
      return;
    }

    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      sendJson(ctx.res, 400, {
        error: `invalid ${label}`,
        issues: issuesToStrings(parsed.error.issues),
        fields: issuesToFields(parsed.error.issues),
      });
      return;
    }

    const result = await fn(parsed.data, ctx);
    sendJson(ctx.res, 200, result ?? { ok: true });
  };
}

/**
 * Resolve `relative` inside `root`, or null if it would escape.
 *
 * The trailing separator matters: without it, a sibling directory whose name
 * merely starts with the root's name would pass the prefix test.
 */
export function resolveWithin(root: string, relative: string): string | null {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, relative);
  if (!resolved.startsWith(absoluteRoot + path.sep)) return null;
  return resolved;
}

/**
 * Reject a cross-site request before it can start a run or rewrite config.
 *
 * This is not authentication — there is nothing to authenticate to. It stops a
 * page you happen to have open from driving your dashboard behind your back,
 * which became a real concern once the API could spend cloud tokens. A request
 * with no Origin header (curl, a plain form) is allowed, exactly as before.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return origin === `http://${BIND_HOST}:${port}` || origin === `http://localhost:${port}`;
}

/** Repeatable query params arrive as `?recommendation=APPLY&recommendation=SKIP`. */
export function listParam(params: URLSearchParams, name: string): string[] | undefined {
  const values = params
    .getAll(name)
    .flatMap((v) => v.split(','))
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export function numberParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
