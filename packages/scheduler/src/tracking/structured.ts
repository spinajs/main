import type { StructuredError } from '../contract.js';

const MAX_STACK = 8000;
const MAX_DATA = 4096;

export function safeJson(v: unknown): string | null {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? null : s;
  } catch {
    return null;
  }
}

export function toStructuredError(
  err: unknown,
  o: { attempt: number; occurredAt: number; step?: string | null },
): StructuredError {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeJson(err) ?? String(err));
  const out: StructuredError = {
    name: e.name || 'Error',
    message: e.message ?? '',
    attempt: o.attempt,
    occurredAt: new Date(o.occurredAt).toISOString(),
  };
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  if (e.stack) out.stack = e.stack.slice(0, MAX_STACK);
  if (o.step) out.step = o.step;
  const data = (e as { data?: unknown }).data;
  if (data !== undefined) {
    const json = safeJson(data);
    if (json !== null && json.length <= MAX_DATA) out.data = JSON.parse(json);
  }
  return out;
}
