import { isFactory } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

export interface NamedEntry {
  readonly name: string;
  readonly service: string;
}

export const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

export const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

export const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * A `{ name, service }` list such as `authn.strategies` or `authn.mfa.steps`. Config files merge arrays by concat, so a
 * file that repeats the package default lists an entry twice: an exact repeat is dropped. Errors name indexes, names
 * and services only: a malformed entry may carry options with secrets.
 */
export function readNamedEntries(raw: unknown, path: string, noun: string): NamedEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidOption(`${path} must be a list of { name, service } entries, got ${kindOf(raw)}`);
  const services = new Map<string, string>();
  const entries: NamedEntry[] = [];
  raw.forEach((item: unknown, i) => {
    const e = item as Partial<NamedEntry> | null;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      throw new InvalidOption(`${path}[${i}] must be a { name, service } object, got ${kindOf(item)}`);
    }
    const { name, service } = e;
    if (!nonEmpty(name) || !nonEmpty(service)) {
      const bad = Object.entries({ name, service }).filter(([, v]) => !nonEmpty(v));
      throw new InvalidOption(`${path}[${i}]: ${bad.map(([k]) => k).join(' and ')} must be a non-empty string`);
    }
    const known = services.get(name);
    if (known === service) return;
    if (known !== undefined) {
      throw new InvalidOption(`${path}: duplicate ${noun} name ${q(name)} with services ${q(known)} and ${q(service)}`);
    }
    services.set(name, service);
    entries.push({ name, service });
  });
  return entries;
}

export type Registration = Class<unknown> | Factory<unknown>;

export const registrationName = (t: unknown): string => {
  const n = (t as { name?: unknown }).name;
  return typeof n === 'string' ? n : '';
};

/** Names of the registrations of `base` along the container lineage, without repeats. */
export function registeredNames(container: IContainer, base: Class<unknown>): string[] {
  return [...new Set((container.getRegisteredTypes(Array.chainOf(base)) ?? []).map(registrationName).filter(nonEmpty))];
}

/** The registration of `base` named `name` nearest to `container` (its own before its ancestors'). */
export function nearestRegistration(container: IContainer, base: Class<unknown>, name: string): Registration | undefined {
  return [...(container.getRegisteredTypes(Array.chainOf(base)) ?? [])].reverse().find((t) => registrationName(t) === name);
}

/** A factory is called with the container; a class resolves through DI, so its lifetime decorators apply. */
export async function instantiate(container: IContainer, type: Registration): Promise<unknown> {
  return isFactory(type) ? await (type as Factory<unknown>)(container) : await container.resolve(type as Class<unknown>);
}
