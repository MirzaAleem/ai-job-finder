import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs.js';

/**
 * Reading and rewriting a .env file without destroying it.
 *
 * The dashboard now edits settings that used to be hand-written, and .env is
 * full of explanatory comments that took real effort to write. So edits are
 * line surgery: only the lines whose keys changed are touched, and everything
 * else — comments, blank lines, ordering, unrelated keys — survives byte for
 * byte. This generalises what the interactive model picker in
 * src/cli/models.ts has always done for a single line.
 *
 * Multi-line quoted values are not supported. Nothing in this project's
 * configuration uses them, and pretending to handle them would risk silently
 * corrupting a file we promised to preserve.
 */

const LINE = /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** True when a value has to be quoted to survive a round trip through dotenv. */
function needsQuoting(value: string): boolean {
  return value === '' ? false : /[\s#"'\\]/.test(value);
}

export function serialiseValue(value: string): string {
  if (!needsQuoting(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

export function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length > 1 && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    if (quote === "'") return inner;
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  // Unquoted: an inline comment ends the value, matching dotenv.
  return trimmed.replace(/\s+#.*$/, '').trim();
}

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const [, , key = '', raw = ''] = match;
    values[key] = parseValue(raw);
  }
  return values;
}

const APPENDED_HEADER = '# Added by the dashboard';

/**
 * Rewrite only the given keys. A null value deletes that key's line.
 *
 * Pure string in, string out — which is what makes it worth testing hard.
 */
export function applyEnvEdits(contents: string, updates: Record<string, string | null>): string {
  const pending = new Map(Object.entries(updates));
  if (pending.size === 0) return contents;

  const hadTrailingNewline = contents === '' || contents.endsWith('\n');
  const lines = contents.split(/\r?\n/);
  if (hadTrailingNewline && lines.at(-1) === '') lines.pop();

  const kept: string[] = [];
  for (const line of lines) {
    const match = LINE.exec(line);
    const key = match?.[2];

    if (key === undefined || !pending.has(key)) {
      kept.push(line);
      continue;
    }

    const value = pending.get(key) ?? null;
    pending.delete(key);
    // A null drops the line entirely; anything else replaces it in place,
    // keeping the original indentation.
    if (value !== null) kept.push(`${match?.[1] ?? ''}${key}=${serialiseValue(value)}`);
  }

  const additions = [...pending].filter((entry): entry is [string, string] => entry[1] !== null);
  if (additions.length > 0) {
    if (kept.length > 0 && kept.at(-1) !== '') kept.push('');
    if (!kept.includes(APPENDED_HEADER)) kept.push(APPENDED_HEADER);
    for (const [key, value] of additions) kept.push(`${key}=${serialiseValue(value)}`);
  }

  const result = kept.join('\n');
  return result === '' ? '' : `${result}\n`;
}

/** Atomic, so a crash mid-write cannot truncate .env. */
export async function writeEnvFile(envPath: string, contents: string): Promise<void> {
  await writeFileAtomic(envPath, contents);
}

export async function readEnvFile(envPath: string): Promise<string> {
  const absolute = path.resolve(envPath);
  if (!existsSync(absolute)) return '';
  return readFile(absolute, 'utf8');
}

/** Read, edit, write. Returns the parsed values as they now stand on disk. */
export async function updateEnvFile(
  envPath: string,
  updates: Record<string, string | null>,
): Promise<Record<string, string>> {
  const contents = await readEnvFile(envPath);
  const next = applyEnvEdits(contents, updates);
  await writeEnvFile(envPath, next);
  return parseEnvFile(next);
}
