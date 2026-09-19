import path from 'node:path';
import { loadEnv, type Env } from '../config/env.js';
import { parseEnvFile, readEnvFile, updateEnvFile } from '../config/env-file.js';
import type { Logger } from '../util/logger.js';
import type { ValidationIssue } from './http.js';

export class SettingsValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super('invalid settings');
    this.name = 'SettingsValidationError';
  }
}

/**
 * The server's view of .env, and the only thing allowed to change it.
 *
 * The dashboard can now rewrite settings while it is running, so handlers must
 * never capture a frozen Env — they read through current() instead. The parsed
 * value is held in memory and swapped only after a write succeeds, so a
 * rejected edit leaves both the file and the running config untouched, and a
 * concurrent request can never observe a half-applied change.
 *
 * process.env is deliberately never mutated: loadEnv memoises it globally, and
 * changing it here would quietly alter what the CLI sees in the same process.
 */
export interface ConfigStore {
  envPath: string;
  /** The validated, defaulted view the pipeline consumes. */
  current(): Env;
  /** What the process booted with, for spotting settings that need a restart. */
  boot(): Env;
  /** Keys exactly as they are written in .env, before Zod defaults apply. */
  raw(): Record<string, string>;
  /** Validate, write, then swap. Throws SettingsValidationError on bad input. */
  apply(updates: Record<string, string | null>): Promise<Env>;
  /** Re-read from disk, for a file edited by hand while the server runs. */
  reload(): Promise<Env>;
}

export interface CreateConfigStoreOptions {
  envPath: string;
  /** The env the process booted with, used for keys set outside the file. */
  fallback: Env;
  logger: Logger;
  /**
   * The environment .env is layered over. Defaults to the real process
   * environment so an exported variable still resolves; tests pass an empty
   * object so the developer's own shell cannot change what they assert.
   */
  baseEnv?: NodeJS.ProcessEnv;
}

export async function createConfigStore(options: CreateConfigStoreOptions): Promise<ConfigStore> {
  const envPath = path.resolve(options.envPath);
  const { logger } = options;
  const baseEnv = options.baseEnv ?? process.env;

  let fileValues = parseEnvFile(await readEnvFile(envPath));
  let env = options.fallback;
  const bootEnv = options.fallback;

  /**
   * Layer the file over the real process environment, so a variable exported in
   * the shell still resolves while .env stays authoritative for what it defines.
   */
  function parse(values: Record<string, string>): Env {
    return loadEnv({ ...baseEnv, ...values });
  }

  function validate(values: Record<string, string>): Env {
    try {
      return parse(values);
    } catch (err) {
      throw new SettingsValidationError(issuesFromEnvError(err));
    }
  }

  return {
    envPath,
    current: () => env,
    boot: () => bootEnv,
    raw: () => ({ ...fileValues }),

    async apply(updates) {
      const merged = { ...fileValues };
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }

      // Validate before touching the file: an invalid .env would make every
      // later loadEnv() throw, including the next CLI run.
      const next = validate(merged);

      fileValues = await updateEnvFile(envPath, updates);
      env = next;
      logger.debug('DB', 'settings written', { keys: Object.keys(updates) });
      return env;
    },

    async reload() {
      fileValues = parseEnvFile(await readEnvFile(envPath));
      env = validate(fileValues);
      return env;
    },
  };
}

/**
 * loadEnv throws one multi-line Error rather than returning Zod issues, so the
 * per-key lines are recovered here to give the UI field-level errors.
 */
function issuesFromEnvError(err: unknown): ValidationIssue[] {
  const message = err instanceof Error ? err.message : String(err);
  const issues: ValidationIssue[] = [];

  for (const line of message.split('\n')) {
    const match = /^\s*-\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(line);
    if (match) issues.push({ path: [match[1] as string], message: match[2] as string });
  }

  return issues.length > 0 ? issues : [{ path: [], message }];
}
