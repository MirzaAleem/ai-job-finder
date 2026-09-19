import { describe, it, expect } from 'vitest';
import { matchRoute, allowedMethods, type Route } from '../../src/dashboard/router.js';

const noop = async (): Promise<void> => undefined;

const routes: Route[] = [
  { method: 'GET', path: '/api/stats', handle: noop },
  { method: 'GET', path: '/api/runs/stream', handle: noop },
  { method: 'POST', path: '/api/runs', handle: noop },
  { method: 'GET', path: /^\/api\/runs\/(\d{1,15})$/, handle: noop },
  { method: 'PATCH', path: /^\/api\/jobs\/(?<jobId>\d{1,15})\/application$/, handle: noop },
  { method: 'POST', path: /^\/api\/jobs\/(?<jobId>\d{1,15})\/application$/, handle: noop },
];

describe('matchRoute', () => {
  it('matches an exact path and method', () => {
    const result = matchRoute(routes, 'GET', '/api/stats');
    expect(result).not.toBeNull();
    expect(result).not.toBe('method-not-allowed');
    if (result && result !== 'method-not-allowed') {
      expect(result.route.path).toBe('/api/stats');
      expect(result.params).toEqual({});
    }
  });

  it('returns numbered captures from a regex path', () => {
    const result = matchRoute(routes, 'GET', '/api/runs/4210');
    expect(result).not.toBe('method-not-allowed');
    if (result && result !== 'method-not-allowed') {
      expect(result.params['1']).toBe('4210');
    }
  });

  it('returns named captures alongside numbered ones', () => {
    const result = matchRoute(routes, 'PATCH', '/api/jobs/77/application');
    expect(result).not.toBe('method-not-allowed');
    if (result && result !== 'method-not-allowed') {
      expect(result.params.jobId).toBe('77');
      expect(result.params['1']).toBe('77');
    }
  });

  it('reports method-not-allowed when only the method is wrong', () => {
    expect(matchRoute(routes, 'POST', '/api/stats')).toBe('method-not-allowed');
  });

  it('returns null when nothing matches the path', () => {
    expect(matchRoute(routes, 'GET', '/api/nope')).toBeNull();
  });

  it('does not let a parameterised route swallow a literal one', () => {
    // '/api/runs/stream' is registered first and the digit-only capture would
    // not match it anyway — both defences are deliberate.
    const result = matchRoute(routes, 'GET', '/api/runs/stream');
    expect(result).not.toBe('method-not-allowed');
    if (result && result !== 'method-not-allowed') {
      expect(result.route.path).toBe('/api/runs/stream');
    }
  });

  it('rejects a non-numeric id rather than matching loosely', () => {
    expect(matchRoute(routes, 'PATCH', '/api/jobs/nonsense/application')).toBeNull();
  });

  it('rejects an id longer than the bound', () => {
    expect(matchRoute(routes, 'GET', `/api/runs/${'9'.repeat(16)}`)).toBeNull();
  });

  it('lets one path serve several methods', () => {
    expect(matchRoute(routes, 'POST', '/api/jobs/5/application')).not.toBe('method-not-allowed');
    expect(matchRoute(routes, 'PATCH', '/api/jobs/5/application')).not.toBe('method-not-allowed');
    expect(matchRoute(routes, 'DELETE', '/api/jobs/5/application')).toBe('method-not-allowed');
  });
});

describe('allowedMethods', () => {
  it('lists every method a path accepts', () => {
    expect(allowedMethods(routes, '/api/jobs/5/application').sort()).toEqual(['PATCH', 'POST']);
  });

  it('is empty for an unknown path', () => {
    expect(allowedMethods(routes, '/api/nope')).toEqual([]);
  });
});
