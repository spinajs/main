import { renderTemplate } from '@spinajs/log-common';

const isFields = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error);

/** The message a Log call writes: a merging-object call's template rendered against its fields, else its first string. */
export function logText(args: unknown[]): string {
  const [first, template] = args;
  if (isFields(first) && typeof template === 'string') {
    return renderTemplate(template, first);
  }
  return String(args.find((a) => typeof a === 'string'));
}

/** The Error a Log call carries, as its first argument or as the `error` field. */
export function loggedError(args: unknown[]): unknown {
  const [first] = args;
  return isFields(first) ? first.error : args.find((a) => a instanceof Error);
}
