import { isFactory } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';

export interface NamedEntry {
  readonly name: string;
  readonly service: string;
}

export const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

export const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

export const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

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
