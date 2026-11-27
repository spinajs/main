// Some collectors take the API key as a path segment; a long or encoded segment is masked rather than guessed at.
const PLAIN_PATH_SEGMENT = /^[\w.~-]{0,16}$/;

/** The endpoint without userinfo, query and fragment, and with every path segment that may be a token masked, for logs. */
export function loggableEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return '<not a URL>';
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (PLAIN_PATH_SEGMENT.test(segment) ? segment : '***'))
    .join('/');
  return `${url.protocol}//${url.host}${path}`;
}
