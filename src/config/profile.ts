import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CandidateProfileSchema, type CandidateProfile } from '../domain/profile.schema.js';

export class ProfileNotFoundError extends Error {
  constructor(filePath: string) {
    super(
      `Profile not found at "${filePath}".\n` +
        `Copy the example and edit it:\n  cp config/profile.example.yaml ${filePath}`,
    );
    this.name = 'ProfileNotFoundError';
  }
}

export class ProfileValidationError extends Error {
  constructor(filePath: string, issues: string) {
    super(`Profile at "${filePath}" is invalid:\n${issues}`);
    this.name = 'ProfileValidationError';
  }
}

export function parseProfile(raw: unknown, filePath = '<inline>'): CandidateProfile {
  const result = CandidateProfileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ProfileValidationError(filePath, issues);
  }
  return result.data;
}

export async function loadProfile(filePath: string): Promise<CandidateProfile> {
  const abs = path.resolve(filePath);
  if (!existsSync(abs)) throw new ProfileNotFoundError(filePath);
  const contents = await readFile(abs, 'utf8');
  return parseProfile(parseYaml(contents), filePath);
}
