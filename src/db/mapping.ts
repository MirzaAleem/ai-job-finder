/**
 * Row <-> domain conversions.
 *
 * SQLite has no JSON, boolean, or date types, so three conventions are applied
 * consistently across every table: structured values are JSON text, booleans are
 * 0/1 integers, and instants are ISO-8601 UTC strings. ISO-8601 is stored rather
 * than epoch millis because it sorts and compares lexicographically — `>=` on a
 * date column is a plain string comparison — and because it stays readable when
 * you open the file in any SQLite browser.
 */

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    const parsed = JSON.parse(text) as T | null;
    return parsed === null ? fallback : parsed;
  } catch {
    // A hand-edited or truncated row should degrade to the default, not crash a run.
    return fallback;
  }
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Non-null variant, for columns declared NOT NULL. */
export function toIsoRequired(value: Date | string): string {
  return toIso(value) as string;
}

export function toDate(value: string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

export function toDateRequired(value: string): Date {
  return new Date(value);
}

export function toBool(value: number | null | undefined): boolean {
  return value === 1;
}

export function fromBool(value: boolean | null | undefined): 0 | 1 {
  return value ? 1 : 0;
}

/** `LIKE` treats these as wildcards; callers want them literal. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
