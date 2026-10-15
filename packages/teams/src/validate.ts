import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import type { Page } from './api.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ROLE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PAGE = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (field: string, message: string) => new InvalidArgument(`${field}: ${message}`, field);

export function readId(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '' || v.length > 64) throw bad(field, 'must be an id of 1 to 64 characters');
  return v;
}

export function readSlug(v: unknown, field = 'slug'): string {
  if (typeof v !== 'string' || !SLUG.test(v)) throw bad(field, 'must be 1 to 64 lowercase letters, digits or inner dashes');
  return v;
}

export function readName(v: unknown, field = 'name'): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (name === '' || name.length > 128) throw bad(field, 'must be 1 to 128 characters');
  return name;
}

export function readDescription(v: unknown, field = 'description'): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > 10000) throw bad(field, 'must be a string of at most 10000 characters');
  return v;
}

export function readRole(v: unknown, field = 'role'): string {
  if (typeof v !== 'string' || !ROLE.test(v)) throw bad(field, 'must be a role name');
  return v;
}

export function readEmail(v: unknown, field = 'email'): string {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (email.length > 255 || !EMAIL.test(email)) throw bad(field, 'must be an email address');
  return email;
}

export function readScope(v: unknown, field = 'scope'): ResourceRef {
  if (!isRecord(v) || typeof v.type !== 'string' || v.type === '') throw bad(field, 'must be { type, id }');
  if (v.type === GLOBAL.type) return GLOBAL;
  if (typeof v.id !== 'string' || v.id === '') throw bad(field, 'must name a resource id');
  return Object.freeze({ type: v.type, id: v.id });
}

export function readPage(v: unknown): Page {
  if (v === undefined) return { limit: 100, offset: 0 };
  const p = isRecord(v) ? v : {};
  const limit = p.limit ?? 100;
  const offset = p.offset ?? 0;
  if (!Number.isInteger(limit) || (limit as number) < 1 || !Number.isInteger(offset) || (offset as number) < 0) throw bad('page', 'must be { limit >= 1, offset >= 0 }');
  return { limit: Math.min(limit as number, MAX_PAGE), offset: offset as number };
}
