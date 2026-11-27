import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import {
  CLOSED_CONFIGURATION_ROOTS,
  OVERRIDABLE_PATH_PATTERN,
  TenantMismatch,
  TenantUnavailable,
  checkTenantSettings,
  currentTenant,
  isTenantId,
  loadTenantSettings,
  overridablePaths,
  tenantRegistry,
} from '@spinajs/tenancy';
import type { TenantRecord } from '@spinajs/tenancy';
import { DateTime } from 'luxon';

import { TenantModel } from './models/TenantModel.js';
import { toTenantRecord } from './records.js';

type Settings = Readonly<Record<string, unknown>>;

const SETTING_PATH = new RegExp(OVERRIDABLE_PATH_PATTERN);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const withoutKey = (settings: Settings, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(settings).filter(([k]) => k !== key));

// Every object on the way is copied: the stored row's objects are never changed in place.
function withValue(settings: Settings, segments: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = segments;
  const child: unknown = settings[head];
  return { ...settings, [head]: rest.length === 0 ? value : withValue(isRecord(child) ? child : {}, rest, value) };
}

function withoutValue(settings: Settings, segments: readonly string[]): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (rest.length === 0) return withoutKey(settings, head);
  const child: unknown = settings[head];
  return isRecord(child) ? { ...settings, [head]: withoutValue(child, rest) } : { ...settings };
}

// The check must judge what the JSON column will hold: a Date, a toJSON() or an undefined key is stored otherwise.
function jsonForm(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new InvalidArgument('a setting value must be serializable as JSON', 'value', undefined, error);
  }
  if (text === undefined) throw new InvalidArgument('a setting value is JSON (null, a boolean, a number, a string, an array or an object); remove a setting with unset()', 'value');
  const copy: unknown = JSON.parse(text);
  return copy;
}

// What MySQL's TEXT column holds; the settings column is TEXT there.
const MAX_SETTINGS_BYTES = 65_535;

function sized(id: string, settings: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(settings));
  if (bytes > MAX_SETTINGS_BYTES) {
    throw new InvalidArgument(`tenancy-orm: the settings of tenant "${id}" would take ${bytes} bytes of JSON; the limit is ${MAX_SETTINGS_BYTES}`, 'value');
  }
  return settings;
}

/**
 * Writes the overrides of a tenant at the paths `tenancy.config.overridable` lists, in the configuration's shape, after
 * `checkTenantSettings` accepted the whole resulting settings object. In one process the writes of one tenant take
 * turns; two processes that write the same tenant's settings at the same moment can lose one of the two changes.
 */
@Injectable()
export class TenantSettingsService {
  @Config('tenancy.config.overridable', { defaultValue: [] })
  protected Overridable!: unknown;

  /** The last write queued for each tenant; it never rejects. */
  private readonly writing = new Map<string, Promise<void>>();

  /** @throws InvalidArgument for a path that is not listed, TenantMismatch inside another tenant's scope, InvalidOperation for a deleting or deleted tenant, InvalidConfiguration for a refused value */
  public async set(id: string, path: string, value: unknown): Promise<TenantRecord> {
    const segments = this.listedPath(path);
    const json = jsonForm(value);
    return this.write(id, (settings) => sized(id, withValue(withoutKey(settings, path), segments, json)));
  }

  public async unset(id: string, path: string): Promise<TenantRecord> {
    const segments = this.listedPath(path);
    return this.write(id, (settings) => withoutValue(withoutKey(settings, path), segments));
  }

  protected listedPath(path: string): string[] {
    if (typeof path !== 'string' || !SETTING_PATH.test(path)) throw new InvalidArgument(`a setting path is dotted segments of A-Z, a-z, 0-9, _, $ and -, got ${JSON.stringify(path)}`, 'path');
    const segments = path.split('.');
    if (CLOSED_CONFIGURATION_ROOTS.includes(segments[0])) throw new InvalidArgument(`${path}: a tenant cannot override ${segments[0]}.*`, 'path');
    if (!overridablePaths(this.Overridable).some((listed) => listed.join('.') === path)) {
      throw new InvalidArgument(`${path} is not listed in tenancy.config.overridable; a tenant's settings are written only at a listed path`, 'path');
    }
    return segments;
  }

  // Each write reads the whole object and writes it back: two writes of one tenant at once would keep only one change.
  protected write(id: string, change: (settings: Settings) => Record<string, unknown>): Promise<TenantRecord> {
    const scoped = currentTenant();
    if (scoped !== undefined && scoped.id !== id) {
      return Promise.reject(new TenantMismatch(`tenancy-orm: code in tenant "${scoped.id}" cannot write the settings of tenant "${id}"`));
    }
    const written = (this.writing.get(id) ?? Promise.resolve()).then(() => this.writeNow(id, change));
    const settled = written.then(
      () => undefined,
      () => undefined,
    );
    this.writing.set(id, settled);
    void settled.finally(() => {
      if (this.writing.get(id) === settled) this.writing.delete(id);
    });
    return written;
  }

  protected async writeNow(id: string, change: (settings: Settings) => Record<string, unknown>): Promise<TenantRecord> {
    const row = await this.current(id);
    if (row.state === 'deleting' || row.state === 'deleted') throw new InvalidOperation(`tenancy-orm: tenant "${id}" is ${row.state}; its settings are not changed any more`);
    const next = change(isRecord(row.settings) ? row.settings : {});
    await checkTenantSettings(next);
    row.settings = next;
    row.updated_at = DateTime.utc();
    await row.update();
    // The registry cache and this process's settings snapshot would keep the old settings for tenancy.registryCacheMs.
    (await tenantRegistry()).invalidate(id);
    // The first load can join a refresh that read the row before this write; the second reads it again.
    await loadTenantSettings(id);
    await loadTenantSettings(id);
    return toTenantRecord(await this.current(id));
  }

  protected async current(id: string): Promise<TenantModel> {
    // MySQL and MSSQL would find `t1` for `t1 `, and the cache would then be invalidated for the wrong key.
    const row = isTenantId(id) ? await TenantModel.where('id', id).first() : undefined;
    if (!row) throw new TenantUnavailable('unknown', `tenancy-orm: no tenant "${id}"`);
    return row;
  }
}
