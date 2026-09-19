import { getDb } from './connection.js';
import { escapeLike, fromJson, toJson } from './mapping.js';
import { RunRepository } from './run.repository.js';
import type { ApplicationRow, EvaluationRow, JobRow } from './rows.js';
import {
  CLOSED_STATUSES,
  type ApplicationStatus,
  type ApplicationUpdate,
} from '../domain/application.schema.js';
import type { ExperienceRange, SalaryRange } from '../domain/job.schema.js';

export interface DashboardFilters {
  minScore?: number;
  maxScore?: number;
  recommendation?: string[];
  status?: ApplicationStatus[];
  source?: string[];
  company?: string;
  search?: string;
  newOnly?: boolean;
  /** Only jobs seen within this many days. */
  days?: number;
  /** Include DISMISSED and REJECTED, which are hidden by default. */
  includeClosed?: boolean;
  sort?: 'score' | 'posted' | 'firstSeen' | 'company';
  limit?: number;
}

export interface DashboardJob {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string | null;
  remote: string | null;
  salary: string | null;
  experienceRequired: string | null;
  url: string;
  applicationUrl: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;

  score: number | null;
  confidence: number | null;
  recommendation: string | null;
  matchingSkills: string[];
  missingSkills: string[];
  reasons: string[];
  concerns: string[];
  providerUsed: string | null;
  escalated: boolean;
  degraded: boolean;

  status: ApplicationStatus;
  notes: string;
  appliedAt: string | null;
}

export interface DashboardStats {
  total: number;
  byRecommendation: Record<string, number>;
  byStatus: Record<string, number>;
  newToday: number;
  lastRun: {
    startedAt: string;
    completedAt: string | null;
    status: string;
    jobsFetched: number;
    jobsEvaluated: number;
    cloudRequests: number;
    estimatedCloudCost: number;
  } | null;
  sources: string[];
  companies: string[];
}

function formatSalary(salary: SalaryRange): string | null {
  if (!salary) return null;
  if (salary.raw) return salary.raw;
  if (salary.min === null && salary.max === null) return null;
  const currency = salary.currency ?? '';
  const period = salary.period ? ` ${salary.period.toLowerCase()}` : '';
  const range =
    salary.min !== null && salary.max !== null
      ? `${salary.min}-${salary.max}`
      : String(salary.min ?? salary.max);
  return `${currency} ${range}${period}`.trim();
}

function formatExperience(exp: ExperienceRange): string | null {
  if (!exp) return null;
  if (exp.raw) return exp.raw;
  if (exp.minYears !== null && exp.maxYears !== null)
    return `${exp.minYears}-${exp.maxYears} years`;
  if (exp.minYears !== null) return `${exp.minYears}+ years`;
  if (exp.maxYears !== null) return `up to ${exp.maxYears} years`;
  return null;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * Read model for the dashboard. Kept apart from JobRepository, which serves the
 * write-heavy pipeline: these are presentation queries with different shapes and
 * different reasons to change.
 */
export class DashboardRepository {
  private readonly runs = new RunRepository();

  /**
   * Jobs joined to their newest evaluation and their application state.
   *
   * Done as three indexed queries rather than one join: the working set is
   * hundreds of rows, not millions, and "newest evaluation per job" is clearer
   * as a first-wins pass over an ordered list than as a window function.
   */
  async findJobs(filters: DashboardFilters = {}): Promise<DashboardJob[]> {
    const db = getDb();
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filters.days !== undefined) {
      where.push('last_seen_at >= ?');
      params.push(new Date(Date.now() - filters.days * 86_400_000).toISOString());
    }
    if (filters.source?.length) {
      where.push(`source IN (${placeholders(filters.source.length)})`);
      params.push(...filters.source);
    }
    if (filters.company) {
      where.push(`company LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(filters.company)}%`);
    }
    if (filters.search) {
      where.push(
        `(title LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`,
      );
      const pattern = `%${escapeLike(filters.search)}%`;
      params.push(pattern, pattern, pattern);
    }

    const jobRows = db
      .prepare<(string | number)[], JobRow>(
        `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .all(...params);

    if (jobRows.length === 0) return [];

    const jobIds = jobRows.map((row) => row.id);
    const idList = placeholders(jobIds.length);

    const evaluationRows = db
      .prepare<number[], EvaluationRow>(
        `SELECT * FROM job_evaluations WHERE job_id IN (${idList})
          ORDER BY created_at DESC, id DESC`,
      )
      .all(...jobIds);

    const applicationRows = db
      .prepare<number[], ApplicationRow>(
        `SELECT * FROM job_applications WHERE job_id IN (${idList})`,
      )
      .all(...jobIds);

    const latestEvaluation = new Map<number, EvaluationRow>();
    for (const row of evaluationRows) {
      if (!latestEvaluation.has(row.job_id)) latestEvaluation.set(row.job_id, row);
    }

    const applications = new Map<number, ApplicationRow>();
    for (const row of applicationRows) applications.set(row.job_id, row);

    // "New" means first seen in the most recent 24 hours of activity, which is
    // what a daily run produces — not "never seen before", which would be empty
    // on every re-run.
    const newCutoff = new Date(Date.now() - 86_400_000).toISOString();

    let rows: DashboardJob[] = jobRows.map((job) => {
      const evaluation = latestEvaluation.get(job.id);
      const application = applications.get(job.id);

      return {
        id: String(job.id),
        source: job.source,
        company: job.company,
        title: job.title,
        location: job.location ?? null,
        remote: job.remote ?? null,
        salary: formatSalary(fromJson<SalaryRange>(job.salary, null)),
        experienceRequired: formatExperience(
          fromJson<ExperienceRange>(job.experience_required, null),
        ),
        url: job.url,
        applicationUrl: job.application_url ?? job.url,
        postedAt: job.posted_at,
        firstSeenAt: job.first_seen_at,
        lastSeenAt: job.last_seen_at,
        isNew: job.first_seen_at >= newCutoff,

        score: evaluation?.score ?? null,
        confidence: evaluation?.confidence ?? null,
        recommendation: evaluation?.recommendation ?? null,
        matchingSkills: fromJson<string[]>(evaluation?.matching_skills, []),
        missingSkills: fromJson<string[]>(evaluation?.missing_skills, []),
        reasons: fromJson<string[]>(evaluation?.reasons, []),
        concerns: fromJson<string[]>(evaluation?.concerns, []),
        providerUsed: evaluation?.provider_used ?? null,
        escalated: evaluation?.escalated === 1,
        degraded: evaluation?.degraded === 1,

        status: (application?.status as ApplicationStatus) ?? 'NEW',
        notes: application?.notes ?? '',
        appliedAt: application?.applied_at ?? null,
      };
    });

    // --- Filters that depend on the joined data ---
    if (filters.minScore !== undefined) {
      rows = rows.filter((r) => r.score !== null && r.score >= filters.minScore!);
    }
    if (filters.maxScore !== undefined) {
      rows = rows.filter((r) => r.score !== null && r.score <= filters.maxScore!);
    }
    if (filters.recommendation?.length) {
      rows = rows.filter(
        (r) => r.recommendation && filters.recommendation!.includes(r.recommendation),
      );
    }
    if (filters.status?.length) {
      rows = rows.filter((r) => filters.status!.includes(r.status));
    } else if (!filters.includeClosed) {
      rows = rows.filter((r) => !CLOSED_STATUSES.includes(r.status));
    }
    if (filters.newOnly) rows = rows.filter((r) => r.isNew);

    rows.sort(comparator(filters.sort ?? 'score'));
    return filters.limit ? rows.slice(0, filters.limit) : rows;
  }

  /**
   * Upsert application state. Appends to statusHistory on a real transition so
   * the pipeline can be reconstructed later.
   */
  async updateApplication(jobId: string, update: ApplicationUpdate): Promise<void> {
    const db = getDb();
    const id = Number(jobId);
    const now = new Date().toISOString();

    const existing = db
      .prepare<[number], ApplicationRow>('SELECT * FROM job_applications WHERE job_id = ?')
      .get(id);

    if (!existing) {
      db.prepare(
        `INSERT INTO job_applications
           (job_id, status, notes, applied_at, status_history, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        update.status ?? 'NEW',
        update.notes ?? '',
        update.status === 'APPLIED' ? now : null,
        toJson(update.status ? [{ status: update.status, at: now }] : []),
        now,
        now,
      );
      return;
    }

    let { status, notes, applied_at: appliedAt } = existing;
    const history = fromJson<{ status: string; at: string }[]>(existing.status_history, []);

    if (update.status !== undefined && update.status !== existing.status) {
      status = update.status;
      history.push({ status: update.status, at: now });
      // First application only — a later status change must not rewrite the date
      // you actually applied on.
      if (update.status === 'APPLIED' && !appliedAt) appliedAt = now;
    }
    if (update.notes !== undefined) notes = update.notes;

    db.prepare(
      `UPDATE job_applications
          SET status = ?, notes = ?, applied_at = ?, status_history = ?, updated_at = ?
        WHERE job_id = ?`,
    ).run(status, notes, appliedAt, toJson(history), now, id);
  }

  async stats(): Promise<DashboardStats> {
    const db = getDb();

    const jobs = db
      .prepare<[], Pick<JobRow, 'id' | 'source' | 'company' | 'first_seen_at'>>(
        'SELECT id, source, company, first_seen_at FROM jobs',
      )
      .all();

    const applications = db
      .prepare<[], Pick<ApplicationRow, 'status'>>('SELECT status FROM job_applications')
      .all();

    const evaluations = db
      .prepare<[], Pick<EvaluationRow, 'job_id' | 'recommendation'>>(
        'SELECT job_id, recommendation FROM job_evaluations ORDER BY created_at DESC, id DESC',
      )
      .all();

    const lastRun = await this.runs.findLatest();

    const seen = new Set<number>();
    const byRecommendation: Record<string, number> = {};
    for (const row of evaluations) {
      if (seen.has(row.job_id)) continue;
      seen.add(row.job_id);
      byRecommendation[row.recommendation] = (byRecommendation[row.recommendation] ?? 0) + 1;
    }

    const byStatus: Record<string, number> = {};
    for (const row of applications) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }
    // Jobs with no application row are implicitly NEW.
    byStatus.NEW = (byStatus.NEW ?? 0) + (jobs.length - applications.length);

    const cutoff = new Date(Date.now() - 86_400_000).toISOString();

    return {
      total: jobs.length,
      byRecommendation,
      byStatus,
      newToday: jobs.filter((j) => j.first_seen_at >= cutoff).length,
      lastRun: lastRun
        ? {
            startedAt: lastRun.started_at,
            completedAt: lastRun.completed_at,
            status: lastRun.status,
            jobsFetched: lastRun.jobs_fetched,
            jobsEvaluated: lastRun.jobs_evaluated,
            cloudRequests: lastRun.cloud_llm_requests,
            estimatedCloudCost: lastRun.estimated_cloud_cost,
          }
        : null,
      sources: [...new Set(jobs.map((j) => j.source))].sort(),
      companies: [...new Set(jobs.map((j) => j.company))].sort(),
    };
  }
}

function comparator(sort: NonNullable<DashboardFilters['sort']>) {
  return (a: DashboardJob, b: DashboardJob): number => {
    switch (sort) {
      case 'company':
        return a.company.localeCompare(b.company) || (b.score ?? -1) - (a.score ?? -1);
      case 'posted':
        return dateValue(b.postedAt) - dateValue(a.postedAt);
      case 'firstSeen':
        return dateValue(b.firstSeenAt) - dateValue(a.firstSeenAt);
      case 'score':
      default: {
        // Mirrors pipeline/rank.ts: score, then novelty, then recency.
        if ((b.score ?? -1) !== (a.score ?? -1)) return (b.score ?? -1) - (a.score ?? -1);
        if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
        return dateValue(b.postedAt) - dateValue(a.postedAt);
      }
    }
  };
}

function dateValue(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
}
