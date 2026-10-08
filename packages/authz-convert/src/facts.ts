import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConversionError } from './findings.js';
import { isPlain } from './values.js';

/** Rows an operator exports from the 2.x database before the migrations drop `users.Role` (see the migration guide). */
export interface DbFacts {
  readonly users: readonly { readonly id: string; readonly roles: readonly string[] }[];
  readonly tokens: readonly { readonly id: string; readonly roles: readonly string[]; readonly expiresAt: unknown }[];
}

/** What the app's sources say about its models (the `--src` scan). */
export interface SourceFacts {
  /** `@OrmResource('X')` resource → files declaring it, relative to the scanned dir. */
  readonly resources: ReadonlyMap<string, readonly string[]>;
  /** Files that use `@ResourceOwner()`. */
  readonly ownerFiles: ReadonlySet<string>;
  /** Scope names of `@OrmPermission(Model, 'scope')` policies ('default' when the scope is left out). */
  readonly policyScopes: ReadonlySet<string>;
}

// users.Role and rbac_access_tokens.Roles reach an export as a JSON array, a JSON array in a string, or a comma list.
function roleList(v: unknown, at: string): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v) && v.every((r) => typeof r === 'string')) return v.map((r) => r.trim()).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) {
      try {
        return roleList(JSON.parse(s), at);
      } catch {
        throw new ConversionError([`${at}: '${s}' is not a JSON array of role names`]);
      }
    }
    return s
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }
  throw new ConversionError([`${at} must be a role list (array, JSON array or comma list)`]);
}

export function readDbFacts(file: string): DbFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new ConversionError([`cannot read --db file ${file}: ${(err as Error).message}`]);
  }
  if (!isPlain(raw)) throw new ConversionError([`--db file ${file} must hold { "users": [...], "tokens": [...] }`]);
  const rows = (key: string): unknown[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new ConversionError([`--db file ${file}: "${key}" must be an array of rows`]);
    return v;
  };
  const id = (row: Record<string, unknown>, i: number): string => String(row.Login ?? row.Id ?? row.Uuid ?? `#${i}`);
  return {
    users: rows('users').map((row, i) => {
      if (!isPlain(row)) throw new ConversionError([`--db file ${file}: users[${i}] must be an object`]);
      return { id: id(row, i), roles: roleList(row.Role, `users[${i}].Role`) };
    }),
    tokens: rows('tokens').map((row, i) => {
      if (!isPlain(row)) throw new ConversionError([`--db file ${file}: tokens[${i}] must be an object`]);
      return { id: id(row, i), roles: roleList(row.Roles, `tokens[${i}].Roles`), expiresAt: row.ExpiresAt };
    }),
  };
}

const SOURCE = /\.(ts|js|mjs|cjs)$/;
const ORM_RESOURCE = /@OrmResource\(\s*['"`]([^'"`]+)['"`]/g;
const ORM_PERMISSION = /@OrmPermission\(\s*[\w$.]+\s*(?:,\s*['"`]([^'"`]+)['"`])?\s*\)/g;

export function scanSources(dir: string): SourceFacts {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ConversionError([`--src dir ${dir} does not exist`]);
  const resources = new Map<string, string[]>();
  const ownerFiles = new Set<string>();
  const policyScopes = new Set<string>();
  const root = path.resolve(dir);
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) visit(full);
        continue;
      }
      if (!SOURCE.test(e.name) || e.name.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(full, 'utf-8');
      const rel = path.relative(root, full).split(path.sep).join('/');
      for (const m of text.matchAll(ORM_RESOURCE)) {
        if (!resources.has(m[1])) resources.set(m[1], []);
        resources.get(m[1])!.push(rel);
      }
      if (/@ResourceOwner\(/.test(text)) ownerFiles.add(rel);
      for (const m of text.matchAll(ORM_PERMISSION)) policyScopes.add(m[1] ?? 'default');
    }
  };
  visit(root);
  return { resources, ownerFiles, policyScopes };
}
