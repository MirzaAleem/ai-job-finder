import { ApplicationUpdateSchema } from '../../domain/application.schema.js';
import type { DashboardRepository, DashboardFilters } from '../../db/dashboard.repository.js';
import type { Logger } from '../../util/logger.js';
import { handleJson, listParam, numberParam, sendJson } from '../http.js';
import type { Route } from '../router.js';

export function filtersFromQuery(params: URLSearchParams): DashboardFilters {
  const filters: DashboardFilters = {};

  const minScore = numberParam(params, 'minScore');
  if (minScore !== undefined) filters.minScore = minScore;
  const maxScore = numberParam(params, 'maxScore');
  if (maxScore !== undefined) filters.maxScore = maxScore;
  const days = numberParam(params, 'days');
  if (days !== undefined) filters.days = days;
  const limit = numberParam(params, 'limit');
  if (limit !== undefined) filters.limit = limit;

  const recommendation = listParam(params, 'recommendation');
  if (recommendation) filters.recommendation = recommendation;
  const status = listParam(params, 'status');
  if (status) filters.status = status as DashboardFilters['status'];
  const source = listParam(params, 'source');
  if (source) filters.source = source;

  const company = params.get('company');
  if (company) filters.company = company;
  const search = params.get('search');
  if (search) filters.search = search;

  if (params.get('newOnly') === 'true') filters.newOnly = true;
  if (params.get('includeClosed') === 'true') filters.includeClosed = true;

  const sort = params.get('sort');
  if (sort === 'score' || sort === 'posted' || sort === 'firstSeen' || sort === 'company') {
    filters.sort = sort;
  }

  return filters;
}

// Job ids are SQLite rowids: digits only, and bounded so a pathological URL
// cannot become a huge Number() before it is rejected.
const APPLICATION_PATH = /^\/api\/jobs\/(\d{1,15})\/application$/;

export function createJobRoutes(deps: {
  repository: DashboardRepository;
  logger: Logger;
}): Route[] {
  const { repository, logger } = deps;

  const updateApplication = handleJson(
    ApplicationUpdateSchema,
    async (update, ctx) => {
      const jobId = ctx.params['1'] as string;
      await repository.updateApplication(jobId, update);
      logger.debug('DB', 'application updated', { jobId, status: update.status });
      return { ok: true };
    },
    { errorLabel: 'update' },
  );

  return [
    {
      method: 'GET',
      path: '/api/health',
      handle: async ({ res }) => sendJson(res, 200, { ok: true }),
    },
    {
      method: 'GET',
      path: '/api/jobs',
      handle: async ({ res, url }) => {
        const jobs = await repository.findJobs(filtersFromQuery(url.searchParams));
        sendJson(res, 200, { jobs, count: jobs.length });
      },
    },
    {
      method: 'GET',
      path: '/api/stats',
      handle: async ({ res }) => sendJson(res, 200, await repository.stats()),
    },
    { method: 'PATCH', path: APPLICATION_PATH, handle: updateApplication },
    { method: 'POST', path: APPLICATION_PATH, handle: updateApplication },
  ];
}
