import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { RawJobSchema, type RawJob } from '../domain/job.schema.js';
import type { Logger } from '../util/logger.js';
import type { FetchJobsOptions, JobSource, SourceStatus } from './source.js';

export interface ImportSourceOptions {
  filePath: string;
  logger: Logger;
  /** Recorded as the job's source, so imported Wellfound rows say "wellfound". */
  sourceLabel?: string;
}

/** Header aliases, so an export from any board can be dropped in with light editing. */
const FIELD_ALIASES: Record<string, string[]> = {
  externalId: ['externalid', 'id', 'job_id', 'jobid'],
  company: ['company', 'company_name', 'employer', 'organisation', 'organization'],
  title: ['title', 'job_title', 'role', 'position'],
  description: ['description', 'job_description', 'details', 'summary'],
  location: ['location', 'city', 'job_location'],
  remote: ['remote', 'workplace', 'work_type', 'worktype'],
  salary: ['salary', 'compensation', 'pay', 'ctc', 'salary_range'],
  experience: ['experience', 'experience_required', 'years', 'exp'],
  skills: ['skills', 'tags', 'keywords', 'technologies'],
  url: ['url', 'job_url', 'link', 'joburl'],
  applicationUrl: ['applicationurl', 'apply_url', 'application_link', 'applylink'],
  postedAt: ['postedat', 'posted', 'date_posted', 'posted_date', 'published'],
};

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    lowered.set(key.trim().toLowerCase().replace(/\s+/g, '_'), value);
  }

  const out: Record<string, unknown> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (lowered.has(alias)) {
        out[field] = lowered.get(alias);
        break;
      }
    }
  }
  return out;
}

function coerce(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toSkills(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  const text = coerce(value);
  if (!text) return [];
  return text
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The supported route for any board that cannot or should not be automated —
 * Wellfound included. Accepts JSON (an array, or `{ jobs: [...] }`) and CSV with
 * commonly-used header names.
 */
export class ImportJobSource implements JobSource {
  readonly name: string;
  readonly status: SourceStatus = 'SUPPORTED';
  readonly notes = 'Reads jobs from a local JSON or CSV file you provide.';

  constructor(private readonly options: ImportSourceOptions) {
    this.name = options.sourceLabel ?? 'import';
  }

  async fetchJobs(options: FetchJobsOptions = {}): Promise<RawJob[]> {
    const abs = path.resolve(this.options.filePath);
    if (!existsSync(abs)) {
      throw new Error(
        `Import file not found: ${this.options.filePath}. Set IMPORT_FILE to a JSON or CSV file.`,
      );
    }

    const contents = await readFile(abs, 'utf8');
    const rows = abs.toLowerCase().endsWith('.csv')
      ? (parseCsv(contents, { columns: true, skip_empty_lines: true, trim: true }) as Record<
          string,
          unknown
        >[])
      : this.parseJson(contents);

    const jobs: RawJob[] = [];
    let skipped = 0;

    for (const row of rows) {
      const mapped = mapRow(row);
      const candidate = {
        source: this.name,
        externalId: coerce(mapped.externalId),
        company: coerce(mapped.company),
        title: coerce(mapped.title),
        description: coerce(mapped.description),
        location: coerce(mapped.location),
        remote: coerce(mapped.remote),
        salary: coerce(mapped.salary),
        experience: coerce(mapped.experience),
        skills: toSkills(mapped.skills),
        url: coerce(mapped.url),
        applicationUrl: coerce(mapped.applicationUrl),
        postedAt: coerce(mapped.postedAt),
        rawData: row as Record<string, unknown>,
      };

      const parsed = RawJobSchema.safeParse(candidate);
      if (parsed.success) jobs.push(parsed.data);
      else skipped += 1;
    }

    if (skipped > 0) {
      this.options.logger.warn('FETCH', 'import: some rows could not be read', {
        skipped,
        imported: jobs.length,
      });
    }
    this.options.logger.info('FETCH', 'import complete', {
      file: this.options.filePath,
      jobs: jobs.length,
    });

    return options.limit ? jobs.slice(0, options.limit) : jobs;
  }

  private parseJson(contents: string): Record<string, unknown>[] {
    const parsed: unknown = JSON.parse(contents);
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { jobs?: unknown }).jobs)
    ) {
      return (parsed as { jobs: Record<string, unknown>[] }).jobs;
    }
    throw new Error('Import JSON must be an array of jobs, or an object with a "jobs" array.');
  }
}
