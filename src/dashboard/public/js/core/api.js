/* Thin fetch wrappers. Every server error arrives as an ApiError. */

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `The server returned ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body ?? {};
    /** [{path, message}] — used to attach messages to individual inputs. */
    this.fields = body?.fields ?? [];
    this.issues = body?.issues ?? [];
  }
}

async function request(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A dead server is the common case here, not a malformed request.
    throw new ApiError(0, { error: 'Could not reach the server. Is it still running?' });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON error page is still an error; the status carries the meaning.
    parsed = null;
  }

  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}

export const getJson = (url) => request('GET', url);
export const postJson = (url, body) => request('POST', url, body);
export const putJson = (url, body) => request('PUT', url, body);
export const deleteJson = (url) => request('DELETE', url);
export const patchJson = (url, body) => request('PATCH', url, body);
