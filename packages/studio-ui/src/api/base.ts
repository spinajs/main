const DEFAULT_BASE = '/_studio';

export function studioBase(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="spina-studio-base"]');
  return (meta?.content.trim() || DEFAULT_BASE).replace(/\/+$/, '');
}

export function withQuery(path: string, params?: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

export const apiUrl = (path: string, params?: object): string => withQuery(`${studioBase()}/api${path}`, params);

/**
 * The app's global route prefix, from the `spina-app-base` meta of the served index.html: the empty string when the
 * app has none, else a path with a leading slash and no trailing one (`/api`). No meta means no prefix.
 */
export function appBase(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="spina-app-base"]')?.content ?? '';
}

/** telemetry and scheduler-http mount under the app's route prefix, not under the Studio path. */
export const appUrl = (path: string, params?: object): string => withQuery(`${appBase()}${path}`, params);
