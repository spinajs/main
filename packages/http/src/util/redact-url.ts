const REDACTED = '[redacted]';

// Query keys are client-controlled too, and a bare segment (`/reset?eyJhbGciOi...`) can itself be the secret.
// The short cap keeps a token sent as a key out; real query keys are short.
const SAFE_KEY = /^[A-Za-z0-9_.\-[\]]{1,32}$/;

export function urlPath(url: string | undefined): string {
  if (typeof url !== 'string') {
    return '';
  }
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * A request URL fit for log lines and error messages: the path, and the query with every value replaced by
 * `[redacted]`. A key is kept only when its pair has a value and the key is a short identifier; anything else
 * becomes `[redacted]` as a whole.
 *
 * `/a/b?token=x&page=2` -> `/a/b?token=[redacted]&page=[redacted]`
 */
export function redactUrl(url: string | undefined): string {
  if (typeof url !== 'string') {
    return '';
  }
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
      // `?<token>=` and base64 padding (`?<token>==`) are bare segments, not keys.
      const key = eq === -1 || /^=*$/.test(pair.slice(eq + 1)) ? null : decodeKey(pair.slice(0, eq));
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
