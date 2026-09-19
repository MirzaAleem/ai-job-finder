import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CandidateProfileSchema, type CandidateProfile } from '../domain/profile.schema.js';
import { writeFileAtomic } from '../util/fs.js';
import type { ValidationIssue } from '../dashboard/http.js';

/**
 * Reading and writing config/profile.yaml for the dashboard's profile editor.
 *
 * Distinct from src/config/profile.ts, which loads the profile for a run and
 * throws when it cannot. The editor must never be locked out by the very file
 * it exists to repair, so reading here reports a problem instead of raising it.
 */

export type ProfileReadResult =
  | { status: 'ok'; profile: CandidateProfile; yaml: string }
  | { status: 'missing' }
  /** issues is null when the YAML itself would not parse. */
  | { status: 'invalid'; yaml: string; issues: ValidationIssue[] | null; message: string };

export function serialiseProfile(profile: CandidateProfile): string {
  // lineWidth 0 disables wrapping: a long preference should stay on one line
  // rather than being folded into something a human would not have written.
  return stringifyYaml(profile, { lineWidth: 0 });
}

/** Read without throwing, so a broken file can still be opened and fixed. */
export async function readProfileResult(filePath: string): Promise<ProfileReadResult> {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) return { status: 'missing' };

  const yaml = await readFile(absolute, 'utf8');

  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    return {
      status: 'invalid',
      yaml,
      issues: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = CandidateProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 'invalid',
      yaml,
      issues: [...parsed.error.issues],
      message: 'the profile does not match the expected shape',
    };
  }

  return { status: 'ok', profile: parsed.data, yaml: serialiseProfile(parsed.data) };
}

export class ProfileWriteError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[] | null,
  ) {
    super(message);
    this.name = 'ProfileWriteError';
  }
}

/** Validate, then write. Returns the YAML as it now stands on disk. */
export async function writeProfile(
  filePath: string,
  candidate: unknown,
): Promise<{ profile: CandidateProfile; yaml: string }> {
  const parsed = CandidateProfileSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ProfileWriteError('invalid profile', [...parsed.error.issues]);
  }

  const yaml = serialiseProfile(parsed.data);
  await writeFileAtomic(filePath, yaml);
  return { profile: parsed.data, yaml };
}

/**
 * Write hand-edited YAML verbatim, so its comments survive — but only after it
 * has been proved loadable. Saving a profile the pipeline would reject means
 * the next run fails at startup, and by then nobody connects the two events.
 */
export async function writeProfileRaw(
  filePath: string,
  yaml: string,
): Promise<{ profile: CandidateProfile; yaml: string }> {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    throw new ProfileWriteError(
      `that is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }

  const parsed = CandidateProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfileWriteError('invalid profile', [...parsed.error.issues]);
  }

  await writeFileAtomic(filePath, yaml);
  return { profile: parsed.data, yaml };
}
