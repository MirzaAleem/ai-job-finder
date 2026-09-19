import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'csv-stringify/sync';
import type { NormalizedJob } from '../domain/job.schema.js';
import type { RankedJob } from './types.js';

export const CSV_COLUMNS = [
  'score',
  'confidence',
  'recommendation',
  'company',
  'title',
  'location',
  'remote',
  'salary',
  'experienceRequired',
  'postedAt',
  'source',
  'jobUrl',
  'applicationUrl',
  'matchingSkills',
  'missingSkills',
  'reasons',
  'concerns',
  'providerUsed',
  'isNew',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type CsvRow = Record<CsvColumn, string | number>;

function formatSalary(job: NormalizedJob): string {
  if (!job.salary) return 'unknown';
  if (job.salary.raw) return job.salary.raw;
  if (job.salary.min === null && job.salary.max === null) return 'unknown';
  const currency = job.salary.currency ?? '';
  const period = job.salary.period ? ` ${job.salary.period.toLowerCase()}` : '';
  const range =
    job.salary.min !== null && job.salary.max !== null
      ? `${job.salary.min}-${job.salary.max}`
      : String(job.salary.min ?? job.salary.max);
  return `${currency} ${range}${period}`.trim();
}

function formatExperience(job: NormalizedJob): string {
  const exp = job.experienceRequired;
  if (!exp) return 'unknown';
  if (exp.raw) return exp.raw;
  if (exp.minYears !== null && exp.maxYears !== null)
    return `${exp.minYears}-${exp.maxYears} years`;
  if (exp.minYears !== null) return `${exp.minYears}+ years`;
  if (exp.maxYears !== null) return `up to ${exp.maxYears} years`;
  return 'unknown';
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : 'unknown';
}

/** Lists become a single cell; the separator is chosen to survive Excel. */
function joinList(values: string[]): string {
  return values.join('; ');
}

export function toCsvRow(item: RankedJob): CsvRow {
  const { job, evaluation } = item;
  return {
    score: evaluation.score,
    confidence: Number(evaluation.confidence.toFixed(2)),
    recommendation: evaluation.recommendation,
    company: job.company,
    title: job.title,
    location: job.location ?? 'unknown',
    remote: job.remote ?? 'unknown',
    salary: formatSalary(job),
    experienceRequired: formatExperience(job),
    postedAt: formatDate(job.postedAt),
    source: job.source,
    jobUrl: job.url,
    applicationUrl: job.applicationUrl ?? job.url,
    matchingSkills: joinList(evaluation.matchingSkills),
    missingSkills: joinList(evaluation.missingSkills),
    reasons: joinList(evaluation.reasons),
    concerns: joinList(evaluation.concerns),
    providerUsed: evaluation.providerUsed,
    isNew: item.isNew ? 'yes' : 'no',
  };
}

export function buildCsv(items: RankedJob[]): string {
  return stringify(items.map(toCsvRow), {
    header: true,
    columns: [...CSV_COLUMNS],
    // Excel opens UTF-8 CSVs correctly only with a BOM; added at write time.
  });
}

export function outputFileName(prefix: string, extension: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return `${prefix}-${stamp}.${extension}`;
}

export async function writeCsv(
  items: RankedJob[],
  outputDir: string,
  date = new Date(),
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, outputFileName('jobs', 'csv', date));
  await writeFile(filePath, `\ufeff${buildCsv(items)}`, 'utf8');
  return filePath;
}
