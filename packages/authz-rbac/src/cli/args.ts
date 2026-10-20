import type { PrincipalRef, ResourceRef } from '@spinajs/authz';

/** A bad command line: reported as one line and a non-zero exit code, never a stack trace. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `type:id`, split on the first `:`, so ids may contain colons. */
function typeAndId(text: string, what: string): { type: string; id: string } {
  const at = text.indexOf(':');
  const type = at < 0 ? '' : text.slice(0, at).trim();
  const id = at < 0 ? '' : text.slice(at + 1).trim();
  if (type === '' || id === '') throw new CliUsageError(`${what} must look like <type>:<id>, got ${JSON.stringify(text)}`);
  return { type, id };
}

export const parsePrincipalRef = (text: string): PrincipalRef => typeAndId(text, 'a principal');

export const parseResourceRef = (text: string): ResourceRef => typeAndId(text, 'a resource');

/** A subject that can hold roles: SYSTEM and UNATTENDED are engine singletons. */
export function parseSubject(text: string): PrincipalRef {
  const ref = parsePrincipalRef(text);
  if (ref.type === 'system' || ref.type === 'unattended') throw new CliUsageError(`a ${ref.type} principal cannot hold roles`);
  return ref;
}

export function requireText(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === '') throw new CliUsageError(`${what} must not be empty`);
  return value.trim();
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** A date alone is UTC midnight; a time needs a zone, so the same command means the same instant on every host. */
export function parseExpiry(text: string, now: Date = new Date()): Date {
  const t = text.trim();
  const m = DATE.exec(t) ?? DATE_TIME.exec(t);
  if (!m) throw new CliUsageError(`--expires must be an ISO 8601 date (2030-01-02) or date-time with a zone (2030-01-02T03:04:05Z), got ${JSON.stringify(text)}`);

  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new CliUsageError(`--expires is not a calendar date: ${JSON.stringify(text)}`);

  let date = day;
  if (m.length > 4) {
    if (m[7] === undefined) throw new CliUsageError(`--expires needs a time zone (Z or +hh:mm) when it has a time, got ${JSON.stringify(text)}`);
    if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) throw new CliUsageError(`--expires has an invalid time: ${JSON.stringify(text)}`);
    date = new Date(t);
  }

  if (Number.isNaN(date.getTime())) throw new CliUsageError(`--expires must be an ISO 8601 date, got ${JSON.stringify(text)}`);
  if (date.getTime() <= now.getTime()) throw new CliUsageError(`--expires must be in the future, got ${JSON.stringify(text)}`);
  return date;
}

export const parseTagList = (text: string): string[] =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
