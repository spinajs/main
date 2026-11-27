// The same rules as telemetry-otel's loggableEndpoint, kept private here so this package does not depend on telemetry-otel.

// Some collectors take the API key as a path segment; a long or encoded segment is masked rather than guessed at.
const PLAIN_PATH_SEGMENT = /^[\w.~-]{0,16}$/;
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

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The endpoint without userinfo, query and fragment, and with every path segment that may be a token masked, for logs. */
export function loggableEndpoint(endpoint: string): string {
  const url = parsed(endpoint);
  if (url === undefined) return "<not a URL>";
  // Without a host (`apikey:…`, `mailto:…`) everything after the scheme is the opaque part.
  if (url.host === "") return `${url.protocol}//***`;
  const path = url.pathname
    .split("/")
    .map((segment) => (isPlain(segment) ? segment : "***"))
    .join("/");
  return `${url.protocol}//${url.host}${path}`;
}

/** What a failed export may hand to the logger: not the error itself, whose request config holds the endpoint and the headers. */
export interface ILoggableExportError {
  name: string;
  message: string;
  code?: string;
  status?: number;
}

export function loggableExportError(error: unknown, endpoint: string): ILoggableExportError {
  const result: ILoggableExportError = {
    name: error instanceof Error ? error.name : "Error",
    message: redacted(error instanceof Error ? error.message : String(error), endpoint),
  };
  if (typeof error !== "object" || error === null) return result;
  if ("code" in error && typeof error.code === "string") result.code = error.code;
  const response = "response" in error ? error.response : undefined;
  if (typeof response === "object" && response !== null && "status" in response && typeof response.status === "number") result.status = response.status;
  return result;
}

function redacted(message: string, endpoint: string): string {
  if (endpoint === "") return message;
  const url = parsed(endpoint);
  const safe = loggableEndpoint(endpoint);
  let text = message;
  for (const echo of new Set([endpoint, url?.href ?? endpoint])) text = text.split(echo).join(safe);
  for (const part of secretParts(url)) text = text.split(part).join("***");
  return text;
}

function secretParts(url: URL | undefined): string[] {
  if (url === undefined) return [];
  // A parameter's name is kept (`token`), its value is secret; a bare `?abc` is a name with no value, and secret.
  const query = [...url.searchParams].map(([name, value]) => (value === "" ? name : value));
  const raw = [url.username, url.password, url.search.slice(1), url.hash.slice(1), ...query];
  raw.push(...(url.host === "" ? [url.pathname] : url.pathname.split("/").filter((segment) => !isPlain(segment))));
  const parts = raw.flatMap((part) => [part, decoded(part)]).filter((part) => part.length >= MIN_PART);
  return [...new Set(parts)].sort((a, b) => b.length - a.length);
}
