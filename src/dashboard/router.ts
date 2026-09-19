import type { RouteContext } from './http.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
  method: HttpMethod;
  /**
   * An exact pathname, or an anchored regex whose captures become `params`.
   * Named groups are preferred; numbered captures land under '1', '2', …
   */
  path: string | RegExp;
  handle(ctx: RouteContext): Promise<void>;
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

export type MatchResult = RouteMatch | 'method-not-allowed' | null;

function matchPath(path: string | RegExp, pathname: string): Record<string, string> | null {
  if (typeof path === 'string') return path === pathname ? {} : null;

  const match = path.exec(pathname);
  if (!match) return null;

  const params: Record<string, string> = { ...match.groups };
  // Numbered captures, so a route can stay terse when one param needs no name.
  for (let i = 1; i < match.length; i += 1) {
    const value = match[i];
    if (value !== undefined) params[String(i)] = value;
  }
  return params;
}

/**
 * Find the route for a request.
 *
 * Returns 'method-not-allowed' when the path matched but the method did not,
 * so a POST to a read-only endpoint gets a 405 rather than the bare 404 the
 * old if-chain produced.
 *
 * Routes are tried in order, so a literal path must be registered before any
 * parameterised route that could also match it.
 */
export function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): MatchResult {
  let pathMatched = false;

  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params === null) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }

  return pathMatched ? 'method-not-allowed' : null;
}

/** The methods a matched-but-not-allowed path does accept, for the Allow header. */
export function allowedMethods(routes: readonly Route[], pathname: string): HttpMethod[] {
  const methods = new Set<HttpMethod>();
  for (const route of routes) {
    if (matchPath(route.path, pathname) !== null) methods.add(route.method);
  }
  return [...methods];
}
