import type { z } from 'zod';

/**
 * Models wrap JSON in prose, markdown fences, or reasoning blocks. This pulls the
 * payload out without ever falling back to eval or a permissive parser.
 */
export function extractJsonText(raw: string): string | null {
  let text = raw.trim();

  // Reasoning models emit a thinking block before the answer.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/<\|[^|]*\|>/g, '').trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();

  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  const candidates: number[] = [];
  if (firstObject !== -1) candidates.push(firstObject);
  if (firstArray !== -1) candidates.push(firstArray);
  if (candidates.length === 0) return null;

  const start = Math.min(...candidates);
  const open = text[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string; stage: 'extract' | 'json' | 'schema' };

export function parseStructured<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  const jsonText = extractJsonText(raw);
  if (jsonText === null) {
    return { ok: false, error: 'no JSON object found in model output', stage: 'extract' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      stage: 'json',
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `schema mismatch: ${issues}`, stage: 'schema' };
  }
  return { ok: true, value: result.data };
}
