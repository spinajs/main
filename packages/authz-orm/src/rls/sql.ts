import type { ResourceType } from '@spinajs/authz';

import type { RlsSqlContext } from '../plan/index.js';

/** Transaction-local settings the session middleware sets (`set_config(name, value, true)`). */
export const RLS_SETTINGS = Object.freeze({
  /** JSON array of the subject keys the principal acts as (its own, its sets', its usersets'). */
  subjectKeys: 'spina.subject_keys',
  /** JSON array of `{ type, id }`: the principal and its companions, as relation terms see them. */
  principal: 'spina.principal',
  /** 'on' under SYSTEM; honoured only by the bypass policy of the configured role. */
  bypass: 'spina.bypass',
});

export const pgIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export const pgLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

// An unset or empty setting reads as an empty list: a session without settings sees no row.
const jsonSetting = (name: string): string => `COALESCE(NULLIF(current_setting(${pgLiteral(name)}, true), ''), '[]')::jsonb`;

export const SESSION_SUBJECT_KEYS = `SELECT jsonb_array_elements_text(${jsonSetting(RLS_SETTINGS.subjectKeys)})`;

export const SESSION_PRINCIPALS = `SELECT p->>'type' AS principal_type, p->>'id' AS principal_id FROM jsonb_array_elements(${jsonSetting(RLS_SETTINGS.principal)}) AS p`;

export const SESSION_BYPASS = `current_setting(${pgLiteral(RLS_SETTINGS.bypass)}, true) = 'on'`;

export interface RlsTable {
  readonly type: ResourceType;
  /** The table the policies go on. */
  readonly table: string;
  readonly idColumn: string;
  readonly relations: (name: string) => { readonly column: string; readonly typeColumn?: string } | undefined;
  readonly ancestorTable: string;
}

/** What renderSql sees for one table: identifiers quoted, every column qualified with the table. */
export function rlsContext(t: RlsTable): RlsSqlContext {
  const table = pgIdent(t.table);
  const column = (name: string): string => `${table}.${pgIdent(name)}`;
  return Object.freeze({
    type: t.type,
    table,
    id: `${column(t.idColumn)}::text`,
    relation: (name: string) => {
      const r = t.relations(name);
      if (r === undefined) return undefined;
      return Object.freeze({ column: column(r.column), ...(r.typeColumn !== undefined ? { typeColumn: column(r.typeColumn) } : {}) });
    },
    ancestorTable: pgIdent(t.ancestorTable),
    subjectKeys: SESSION_SUBJECT_KEYS,
    principals: SESSION_PRINCIPALS,
    now: 'now()',
    literal: pgLiteral,
    ident: pgIdent,
  });
}
