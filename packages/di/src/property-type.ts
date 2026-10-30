import { token } from './token.js';
import type { IPropertyTypeResolver } from './interfaces.js';
import type { Class } from './types.js';

export const PROPERTY_TYPE_RESOLVER = token<IPropertyTypeResolver>('__property_type_resolver__', 'types of injected properties without decorator metadata');

/** A property whose class has no `design:type`: only the manifest can answer for it. */
export interface IPendingProperty {
  owner: Class<unknown>;
  property: string;
}

// Process-wide, as decorators are: a class is decorated once, whatever boots after it.
const pending: IPendingProperty[] = [];

export function notePendingProperty(owner: Class<unknown>, property: string): void {
  if (!pending.some((p) => p.owner === owner && p.property === property)) {
    pending.push({ owner, property });
  }
}

export function pendingProperties(): readonly IPendingProperty[] {
  return pending;
}

/** For a test that declares classes no manifest it boots lists; `owner` omitted forgets every pair. */
export function forgetPendingProperties(owner?: Class<unknown>): void {
  const kept = owner ? pending.filter((p) => p.owner !== owner) : [];
  pending.length = 0;
  pending.push(...kept);
}
