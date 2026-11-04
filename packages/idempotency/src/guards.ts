import { InvalidArgument } from '@spinajs/exceptions';

export function positive(name: string, ms: number): void {
  if (!(Number.isFinite(ms) && ms > 0)) {
    throw new InvalidArgument(`${name} must be a finite number above 0, got ${ms}`);
  }
}
