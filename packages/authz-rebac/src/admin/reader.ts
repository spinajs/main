import { AuthzAdminFailure, AuthzAdminReader } from '@spinajs/authz';
import type { AdminContext, AuthzAdminQuery, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import type { TupleQuery } from '../contracts.js';
import { NAME_PATTERN } from '../keys.js';
import { querySubject, rebacModels, writableStore } from './common.js';
import type { RebacModel } from '../model/model.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// AuthzAdmin passes a checked page; a direct caller gets the admin's default.
function pageOf(p: unknown): { limit: number; offset: number } {
  if (p === undefined) return { limit: 50, offset: 0 };
  if (!isRecord(p) || !Number.isInteger(p.limit) || !Number.isInteger(p.offset) || (p.limit as number) < 0 || (p.offset as number) < 0) throw new AuthzAdminFailure('invalid_query', 'page must be { limit, offset } with non-negative integers', 'page');
  if (p.after !== undefined) throw new AuthzAdminFailure('invalid_query', 'tuples pages by offset; page.after is not supported', 'page.after');
  return { limit: p.limit as number, offset: p.offset as number };
}

function readQuery(q: Record<string, unknown>): TupleQuery {
  const scope = q.scope;
  if (scope !== undefined && (!isRecord(scope) || typeof scope.type !== 'string' || scope.type === '' || (scope.id != null && (typeof scope.id !== 'string' || scope.id === '')))) throw new AuthzAdminFailure('invalid_query', 'scope must be a resource ref { type, id? }', 'scope');
  if (q.relation !== undefined && (typeof q.relation !== 'string' || !NAME_PATTERN.test(q.relation))) throw new AuthzAdminFailure('invalid_query', 'relation must be a relation name', 'relation');
  return {
    ...(scope !== undefined ? { object: (scope.id == null ? { type: scope.type } : { type: scope.type, id: scope.id }) as ResourceRef } : {}),
    ...(q.relation !== undefined ? { relation: q.relation } : {}),
    ...(q.subject !== undefined ? { subject: querySubject(q.subject) } : {}),
  };
}

function objectOf(v: unknown): ResourceRef {
  if (!isRecord(v) || typeof v.type !== 'string' || v.type === '' || typeof v.id !== 'string' || v.id === '') throw new AuthzAdminFailure('invalid_query', 'scope must be an object ref { type, id }', 'scope');
  return { type: v.type, id: v.id };
}

function nameOf(v: unknown, field: string): string {
  if (typeof v !== 'string' || !NAME_PATTERN.test(v)) throw new AuthzAdminFailure('invalid_query', `${field} must be a name`, field);
  return v;
}

/** The first RebacModel of the domain whose namespaces know object#relation. */
function modelFor(ctx: AdminContext, object: ResourceRef, relation: string): RebacModel {
  const model = rebacModels(ctx).find((m) => m.schema().relation(object.type, relation) !== undefined || m.schema().permission(object.type, relation) !== undefined);
  if (!model) throw new AuthzAdminFailure('not_found', `no RebacModel of the domain knows ${object.type}#${relation}`, 'relation');
  return model;
}

/** tuples.expand and tuples.subjects: Zanzibar's expand and the holders of a relation or permission, read live from the domain's RebacModel. */
@Singleton()
@Injectable(AuthzAdminReader)
export class RebacExpandReader extends AuthzAdminReader {
  readonly kinds = ['tuples.expand', 'tuples.subjects'] as const;

  async list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    if (q.kind !== 'tuples.expand' && q.kind !== 'tuples.subjects') throw new AuthzAdminFailure('not_found', `RebacExpandReader does not answer ${JSON.stringify(q.kind)}`, 'kind');
    const raw = q as unknown as Record<string, unknown>;
    const object = objectOf(raw.scope);
    const relation = nameOf(raw.relation, 'relation');
    const model = modelFor(ctx, object, relation);
    if (q.kind === 'tuples.expand') return { items: [await model.expand(object, relation)], total: 1 };
    const out = await model.listSubjects(object, relation, nameOf(raw.subjectType, 'subjectType'));
    // A list cut short by maxDepth would show holders as missing; an admin UI must not read it as the answer.
    if (!out.complete) throw new AuthzAdminFailure('limit_exceeded', `${object.type}#${relation} nests deeper than maxDepth; its subjects cannot be listed in full`, 'relation');
    return { items: out.subjects, total: out.subjects.length };
  }
}

/** list() of the tuples in the domain's writable TupleStore, narrowed by scope (object or namespace), relation and subject. */
@Singleton()
@Injectable(AuthzAdminReader)
export class RebacTupleReader extends AuthzAdminReader {
  readonly kinds = ['tuples'] as const;

  async list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    if (q.kind !== 'tuples') throw new AuthzAdminFailure('not_found', `RebacTupleReader does not answer ${JSON.stringify(q.kind)}`, 'kind');
    const raw = q as unknown as Record<string, unknown>;
    const query = readQuery(raw);
    const page = pageOf(raw.page);
    const out = await (await writableStore(ctx)).find(query, page);
    return { items: out.items.map((t) => structuredClone(t)), total: out.total };
  }
}
