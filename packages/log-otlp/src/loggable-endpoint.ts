// Some collectors take the API key as a path segment; a long or encoded segment is masked rather than guessed at.
const PLAIN_PATH_SEGMENT = /^[\w.~-]{0,16}$/;
// A message that repeats at least this much of the endpoint's start is taken as an echo of it, possibly cut short.
const MIN_ECHO = 12;
// Shorter parts (`v1`, `api`) are too common in a message to be masked on their own.
const MIN_PART = 4;

const isPlain = (segment: string): boolean => PLAIN_PATH_SEGMENT.test(segment);

function parsed(endpoint: string): URL | undefined {
  try {
    return new URL(endpoint);
  } catch {
    return undefined;
  }
}

function attempt(transform: (text: string) => string, text: string): string | undefined {
  try {
    return transform(text);
  } catch {
    return undefined;
  }
}

/** The endpoint without userinfo, query and fragment, and with every path segment that may be a token masked, for logs. */
export function loggableEndpoint(endpoint: string): string {
  const url = parsed(endpoint);
  if (url === undefined) return '<not a URL>';
  // Without a host (`apikey:…`, `mailto:…`) everything after the scheme is the opaque part.
  if (url.host === '') return `${url.protocol}//***`;
  const path = url.pathname
    .split('/')
    .map((segment) => (isPlain(segment) ? segment : '***'))
    .join('/');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * An error's class and message for a log line next to `loggableEndpoint(endpoint)`: the exporter's messages can repeat
 * the endpoint as configured, so every echo of it, whole or cut short, and every secret part of it is redacted.
 */
export function loggableReason(error: unknown, endpoint: string): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (endpoint === '') return message;
  const url = parsed(endpoint);
  const safe = loggableEndpoint(endpoint);
  const echoes = [endpoint, url?.href, attempt(encodeURI, endpoint), attempt(encodeURIComponent, endpoint)].filter((echo) => echo !== undefined);
  let reason = replaceEchoes(message, [...new Set(echoes)], safe);
  for (const part of secretParts(url)) reason = reason.split(part).join('***');
  return reason;
}

/** Replaces, left to right, the longest run that starts like one of the echoes and matches it as far as it goes. */
function replaceEchoes(text: string, echoes: string[], safe: string): string {
  let result = text;
  let from = 0;
  while (from < result.length) {
    const length = Math.max(0, ...echoes.map((echo) => echoLength(result, from, echo)));
    if (length === 0) {
      from++;
      continue;
    }
    result = result.slice(0, from) + safe + result.slice(from + length);
    from += safe.length;
  }
  return result;
}

function echoLength(text: string, from: number, echo: string): number {
  let length = 0;
  while (length < echo.length && text.charAt(from + length) === echo.charAt(length)) length++;
  return length >= Math.min(MIN_ECHO, echo.length) ? length : 0;
}

function secretParts(url: URL | undefined): string[] {
  if (url === undefined) return [];
  // A parameter's name is kept (`token`), its value is secret; a bare `?abc` is a name with no value, and secret.
  const query = [...url.searchParams].map(([name, value]) => (value === '' ? name : value));
  const raw = [url.username, url.password, url.search.slice(1), url.hash.slice(1), ...query];
  raw.push(...(url.host === '' ? [url.pathname] : url.pathname.split('/').filter((segment) => !isPlain(segment))));
  const parts = raw.flatMap((part) => [part, attempt(decodeURIComponent, part) ?? part]).filter((part) => part.length >= MIN_PART);
  return [...new Set(parts)].sort((a, b) => b.length - a.length);
}
