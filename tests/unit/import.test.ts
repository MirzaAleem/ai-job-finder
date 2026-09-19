import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ImportJobSource } from '../../src/sources/import.source.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { normalizeJob } from '../../src/pipeline/normalize.js';

let dir: string | null = null;

async function fileWith(name: string, contents: string): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'jobfinder-'));
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const logger = createSilentLogger();

describe('import source', () => {
  it('reads a JSON array', async () => {
    const filePath = await fileWith(
      'jobs.json',
      JSON.stringify([
        {
          company: 'Acme',
          title: 'Backend Engineer',
          url: 'https://acme.test/1',
          location: 'Remote',
          salary: '₹30 LPA',
          skills: ['Node.js', 'TypeScript'],
        },
      ]),
    );

    const jobs = await new ImportJobSource({ filePath, logger }).fetchJobs({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe('Acme');
    expect(jobs[0]?.skills).toEqual(['Node.js', 'TypeScript']);
  });

  it('reads a JSON object with a jobs array', async () => {
    const filePath = await fileWith(
      'jobs.json',
      JSON.stringify({
        jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://acme.test/1' }],
      }),
    );
    expect(await new ImportJobSource({ filePath, logger }).fetchJobs({})).toHaveLength(1);
  });

  it('reads a CSV with common header names', async () => {
    const filePath = await fileWith(
      'jobs.csv',
      'Company Name,Job Title,Link,City,Compensation,Tags\n' +
        'Globex,Senior Backend Engineer,https://globex.test/9,Bengaluru,₹40 LPA,"Node.js;TypeScript"\n',
    );

    const jobs = await new ImportJobSource({ filePath, logger }).fetchJobs({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe('Globex');
    expect(jobs[0]?.title).toBe('Senior Backend Engineer');
    expect(jobs[0]?.url).toBe('https://globex.test/9');
    expect(jobs[0]?.location).toBe('Bengaluru');
    expect(jobs[0]?.skills).toEqual(['Node.js', 'TypeScript']);
  });

  it('labels imported jobs with the configured source name', async () => {
    const filePath = await fileWith(
      'jobs.json',
      JSON.stringify([{ company: 'A', title: 'B', url: 'https://a.test/1' }]),
    );
    const jobs = await new ImportJobSource({
      filePath,
      logger,
      sourceLabel: 'wellfound',
    }).fetchJobs({});
    expect(jobs[0]?.source).toBe('wellfound');
  });

  it('imports rows that normalize successfully end to end', async () => {
    const filePath = await fileWith(
      'jobs.json',
      JSON.stringify([
        {
          company: 'Acme',
          title: 'Backend Engineer',
          url: 'https://acme.test/1',
          experience: '5-8 years',
          salary: '₹35 LPA',
          description: '<p>Build things.</p>',
        },
      ]),
    );

    const [raw] = await new ImportJobSource({ filePath, logger }).fetchJobs({});
    const normalized = normalizeJob(raw!);
    expect(normalized.experienceRequired?.minYears).toBe(5);
    expect(normalized.salary?.min).toBe(3_500_000);
    expect(normalized.description).toBe('Build things.');
  });

  it('skips unusable rows instead of failing the whole import', async () => {
    const filePath = await fileWith(
      'jobs.json',
      JSON.stringify([
        { company: 'Good', title: 'Engineer', url: 'https://good.test/1' },
        { notAJob: true },
      ]),
    );
    const jobs = await new ImportJobSource({ filePath, logger }).fetchJobs({});
    expect(jobs).toHaveLength(2);
    // Rows without a title/company survive import but are dropped at normalization.
    expect(() => normalizeJob(jobs[1]!)).toThrow();
  });

  it('respects a limit', async () => {
    const filePath = await fileWith(
      'jobs.json',
      JSON.stringify(
        Array.from({ length: 5 }, (_, i) => ({
          company: 'A',
          title: 'B',
          url: `https://a.test/${i}`,
        })),
      ),
    );
    expect(await new ImportJobSource({ filePath, logger }).fetchJobs({ limit: 2 })).toHaveLength(2);
  });

  it('gives a clear error when the file is missing', async () => {
    await expect(
      new ImportJobSource({ filePath: '/nope/missing.json', logger }).fetchJobs({}),
    ).rejects.toThrow(/Import file not found/);
  });

  it('gives a clear error for JSON that is not a job list', async () => {
    const filePath = await fileWith('jobs.json', JSON.stringify({ nope: true }));
    await expect(new ImportJobSource({ filePath, logger }).fetchJobs({})).rejects.toThrow(
      /must be an array of jobs/,
    );
  });
});
