import { renderTemplate } from '@spinajs/log';

const withErrors = (_key: string, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);

/** One line per call: a fields call is rendered and carries its raw fields too, so a "logs no secret" check sees both. */
export function logLine(...args: unknown[]): string {
  const [first, template, ...rest] = args;
  if (first instanceof Error) {
    return [String(template), JSON.stringify(first, withErrors), ...rest.map(String)].join(' ');
  }
  if (first !== null && typeof first === 'object') {
    return [renderTemplate(String(template ?? ''), first as Record<string, unknown>), JSON.stringify(first, withErrors), ...rest.map(String)].join(' ');
  }
  return args.map(String).join(' ');
}

/** A `warn`/`error` log double that records into `lines`. */
export function recordingLog(lines: string[]): { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void } {
  const record = (...args: unknown[]) => void lines.push(logLine(...args));
  return { warn: record, error: record };
}
