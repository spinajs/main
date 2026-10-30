import { token } from './token.js';
import type { IPropertyTypeResolver } from './interfaces.js';
import type { Class } from './types.js';

export const PROPERTY_TYPE_RESOLVER = token<IPropertyTypeResolver>('__property_type_resolver__', 'types of injected properties without decorator metadata');

/** A property whose class has no `design:type`: only the manifest can answer for it. */
export interface IPendingProperty {
  owner: Class<unknown>;
  property: string;
  /** An explicit class bound with no resolver to ask: one instance, even if the property is a list. */
  boundSingle?: boolean;
}

// Process-wide, as decorators are: a class is decorated once, whatever boots after it.
const pending: IPendingProperty[] = [];

const pairOf = (owner: Class<unknown>, property: string) => pending.find((p) => p.owner === owner && p.property === property);

export function notePendingProperty(owner: Class<unknown>, property: string): void {
  if (!pairOf(owner, property)) {
    pending.push({ owner, property });
  }
}

export function noteBoundSingle(owner: Class<unknown>, property: string): void {
  const pair = pairOf(owner, property);
  if (pair) {
    pair.boundSingle = true;
  } else {
    pending.push({ owner, property, boundSingle: true });
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
