/** setTimeout fires immediately for a delay above this (a 32-bit signed integer). */
export const MAX_TIMER_MS = 2_147_483_647;

export function assertTimeoutMs(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS)) {
    throw new RangeError(`${name} must be a finite number within (0, ${MAX_TIMER_MS}], got ${value}`);
  }
  return value;
}
