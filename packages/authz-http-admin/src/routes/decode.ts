/** Date, time (seconds and fraction optional) and `Z` or an offset: the only strings read as a Date. */
export const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Command kinds whose top-level `expiresAt`, or `expiresAt` inside one nested object, is a Date. */
const DATE_PATHS: Readonly<Record<string, string | null>> = {
  'assignment.grant': null,
  'assignment.setExpiry': null,
  'set.addMember': null,
  'link.create': null,
  'link.update': null,
  'rule.put': 'rule',
  'policy.put': 'policy',
};

function toDate(v: unknown): unknown {
  if (typeof v !== 'string' || !ISO_DATE_TIME.test(v)) return v;
  const at = new Date(v);
  return Number.isNaN(at.getTime()) ? v : at;
}

function withDate(o: Record<string, unknown>): Record<string, unknown> {
  return 'expiresAt' in o ? { ...o, expiresAt: toDate(o.expiresAt) } : o;
}

/**
 * A command as JSON carries its expiry dates as strings; this copy holds Dates at the known expiry
 * paths. Anything else, including a string that is not an ISO date-time, stays as it came, so
 * AuthzAdmin refuses it as it would refuse it in-process.
 */
export function decodeCommand(command: unknown): unknown {
  if (!isRecord(command) || typeof command.kind !== 'string' || !Object.hasOwn(DATE_PATHS, command.kind)) return command;
  const nested = DATE_PATHS[command.kind];
  if (nested === null) return withDate(command);
  const inner = command[nested];
  return isRecord(inner) ? { ...command, [nested]: withDate(inner) } : command;
}

/** decodeCommand for each entry of a list; anything else goes through for AuthzAdmin to refuse. */
export function decodeCommands(commands: unknown): unknown {
  return Array.isArray(commands) ? commands.map(decodeCommand) : commands;
}
