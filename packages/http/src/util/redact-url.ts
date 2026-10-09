const REDACTED = '[redacted]';

// Query keys are client-controlled too, and a bare segment (`/reset?eyJhbGciOi...`) can itself be the secret.
const SAFE_KEY = /^[A-Za-z0-9_.\-[\]]{1,64}$/;

/**
 * The path of a request URL without its query.
 */
export function urlPath(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * A request URL fit for log lines and error messages: the path, and the query with every value replaced by
 * `[redacted]`. A key is kept only when its pair has `=` and the key is a short identifier; anything else
 * becomes `[redacted]` as a whole.
 *
 * `/a/b?token=x&page=2` -> `/a/b?token=[redacted]&page=[redacted]`
 */
export function redactUrl(url: string): string {
  const path = urlPath(url);
  if (path.length === url.length) {
    return url;
  }

  const pairs = url
    .slice(path.length + 1)
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? null : decodeKey(pair.slice(0, eq));
      return key !== null && SAFE_KEY.test(key) ? `${key}=${REDACTED}` : REDACTED;
    });

  return pairs.length === 0 ? path : `${path}?${pairs.join('&')}`;
}

function decodeKey(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}
