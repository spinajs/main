import { apiUrl } from './base';
import type { DataOrigin, Sourced, StudioCapabilities } from './types';

export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: { message?: unknown } };
    const message = body.message ?? body.error?.message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // Not JSON: the status line is all there is.
  }
  return response.statusText || `HTTP ${response.status}`;
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new ApiError(response.status, await messageOf(response), url);
  return (await response.json()) as T;
}

export const getJson = <T>(url: string, signal?: AbortSignal): Promise<T> => request<T>(url, { method: 'GET', signal });

export const postJson = <T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> => request<T>(url, { method: 'POST', body: JSON.stringify(body), signal });

const isOrigin = (value: unknown): value is DataOrigin => value === 'manifest' || value === 'runtime' || value === 'merged';

function isSourced<T>(body: T | { source: DataOrigin; data: T }): body is { source: DataOrigin; data: T } {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'data' in body && 'source' in body && isOrigin(body.source);
}

/** Studio answers `{ source, data }` where the data has a manifest or runtime origin (E10), the bare value elsewhere. */
export function unwrapSourced<T>(body: T | { source: DataOrigin; data: T }): Sourced<T> {
  return isSourced(body) ? { source: body.source, data: body.data } : { data: body };
}

export const fetchCapabilities = (signal?: AbortSignal): Promise<StudioCapabilities> => getJson<StudioCapabilities>(apiUrl('/capabilities'), signal);
