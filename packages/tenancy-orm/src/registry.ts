import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument, NotSupported } from '@spinajs/exceptions';
import { Orm, extractModelDescriptor } from '@spinajs/orm';

// Every module of the package reaches the registry, so a second copy fails before it registers anything.
import './once.js';
import { TENANCY_ORM_DEFAULTS } from './schema.js';

export type TenantIsolation = 'row' | 'schema';

export interface TenantModelOptions {
  isolation?: TenantIsolation;
  column?: string | false;
  rls?: boolean;
}

/** A tenant model with its options laid over `tenancy.orm`. */
export interface TenantModelEntry {
  /** The registered class; for a subclass, its nearest registered ancestor. */
  readonly model: object;
  /** The table of the class asked about, else of the registered class; '' for an abstract base. */
  readonly table: string;
  readonly isolation: 'row';
  readonly column: string;
  readonly rls: boolean;
}

const OPTION_NAMES = ['isolation', 'column', 'rls'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Insertion order is registration order.
const registrations = new Map<object, TenantModelOptions>();
// tenantModelOf runs for every statement; any registry write clears it.
let nearest = new WeakMap<object, object | null>();

export const nameOf = (model: unknown): string => (typeof model === 'function' && model.name !== '' ? model.name : '<anonymous class>');

const optionsKey = (o: TenantModelOptions): string => JSON.stringify([o.isolation ?? null, o.column ?? null, o.rls ?? null]);

function chain(model: object): object[] {
  const out: object[] = [];
  for (let c: unknown = model; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) out.push(c);
  return out;
}

function isolationOf(value: unknown, where: string): { isolation?: TenantIsolation } {
  if (value === undefined) return {};
  if (value === 'schema') throw new NotSupported(`${where}: isolation 'schema' is not available yet; it lands with schema placements (v4-td-05-placement-schema). Use isolation 'row'`);
  if (value !== 'row') throw new InvalidArgument(`${where}: isolation must be 'row' or 'schema', got ${JSON.stringify(value)}`);
  return { isolation: value };
}

function columnOf(value: unknown, where: string): { column?: string | false } {
  if (value === undefined) return {};
  if (value === false) return { column: false };
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new InvalidArgument(`${where}: column must be a column name or false, got ${JSON.stringify(value)}`);
  return { column: value };
}

function rlsOf(value: unknown, where: string): { rls?: boolean } {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw new InvalidArgument(`${where}: rls must be a boolean, got ${JSON.stringify(value)}`);
  return { rls: value };
}

function checked(options: unknown, where: string): TenantModelOptions {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new InvalidArgument(`${where}: options must be an object`);
  const unknownName = Object.keys(options).find((name) => !OPTION_NAMES.includes(name));
  if (unknownName !== undefined) throw new InvalidArgument(`${where}: unknown option '${unknownName}'`);
  return { ...isolationOf(Reflect.get(options, 'isolation'), where), ...columnOf(Reflect.get(options, 'column'), where), ...rlsOf(Reflect.get(options, 'rls'), where) };
}

/** `tenancy.orm.isolation`, `.column` and `.rls`, read on every call: a test application or a reload must not see an earlier one's values. */
function defaults(): { column: string | false; rls: boolean } {
  const raw: unknown = DI.get(Configuration)?.get<unknown>(['tenancy', 'orm']);
  const section = raw !== null && typeof raw === 'object' ? raw : {};
  const where = 'tenancy.orm';
  isolationOf(Reflect.get(section, 'isolation'), where);
  return {
    column: columnOf(Reflect.get(section, 'column'), where).column ?? TENANCY_ORM_DEFAULTS.column,
    rls: rlsOf(Reflect.get(section, 'rls'), where).rls ?? TENANCY_ORM_DEFAULTS.rls,
  };
}

function tableOf(model: unknown): string | undefined {
  const table = extractModelDescriptor(model)?.TableName;
  return table === undefined || table === '' ? undefined : table;
}

function entryOf(registered: object, table = tableOf(registered) ?? ''): TenantModelEntry {
  const own = registrations.get(registered) ?? {};
  const base = defaults();
  const column = own.column ?? base.column;
  if (column === false) throw new InvalidArgument(`${nameOf(registered)}: row isolation needs a tenant column; column: false is for isolation 'schema'`);
  return { model: registered, table, isolation: 'row', column, rls: own.rls ?? base.rls };
}

export function register(model: unknown, options: unknown, decorator: string): void {
  if (typeof model !== 'function') throw new InvalidArgument(`${decorator}: the model must be a class`);
  const next = checked(options, `${nameOf(model)}: ${decorator}`);
  const prev = registrations.get(model);
  if (prev !== undefined) {
    if (optionsKey(prev) === optionsKey(next)) return;
    throw new InvalidArgument(`${nameOf(model)} is already registered as a tenant model with other options`);
  }
  registrations.set(model, next);
  nearest = new WeakMap();
}

export const hasTenantModels = (): boolean => registrations.size > 0;

/** The entry of `model` or of its nearest registered ancestor. Throws when its options cannot be served. */
export function tenantModelOf(model: unknown): TenantModelEntry | undefined {
  if (typeof model !== 'function' || registrations.size === 0) return undefined;
  let registered = nearest.get(model);
  if (registered === undefined) {
    registered = chain(model).find((c) => registrations.has(c)) ?? null;
    nearest.set(model, registered);
  }
  return registered === null ? undefined : entryOf(registered, tableOf(model));
}

/**
 * The tenant model that maps `table`, on any connection, in any letter case: sqlite, MSSQL and MySQL on some systems
 * resolve a table name case-insensitively. The ORM's models cover the subclasses of a registered class.
 */
export function tenantModelOfTable(table: string): TenantModelEntry | undefined {
  if (registrations.size === 0) return undefined;
  const wanted = table.toLowerCase();
  const models: unknown[] = [...registrations.keys(), ...(DI.get(Orm)?.Models.map((m): unknown => m.type) ?? [])];
  for (const model of models) {
    if (tableOf(model)?.toLowerCase() !== wanted) continue;
    const entry = tenantModelOf(model);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/** Every registered tenant model, in registration order. */
export function tenantModels(): TenantModelEntry[] {
  return [...registrations.keys()].map((registered) => entryOf(registered));
}

/** Test seam: forget a class's registration. */
export function unregisterTenantModel(model: object): void {
  registrations.delete(model);
  nearest = new WeakMap();
}
