import { AuthzAdminFailure, AuthzWriteHandler, principalKey } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx, Permission, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import type { Tuple } from '../contracts.js';
import type { TupleProblem } from '../namespace/compile.js';
import { isSubjectSet, subjectKey } from '../keys.js';
import { DbTupleStore, TUPLE_COLUMN_WIDTHS } from '../stores/db.js';
import { actorRef, commandTuple, rebacModels, tupleChanged, tupleTags, writableStore, writeTuples } from './common.js';

export const TUPLES_MANAGE: Permission = 'authz:tuples.manage';

type TupleCommand = Extract<AuthzCommand, { kind: 'tuple.write' | 'tuple.delete' }>;

function tupleCommand(c: AuthzCommand): TupleCommand {
  if (c.kind !== 'tuple.write' && c.kind !== 'tuple.delete') throw new AuthzAdminFailure('not_found', `RebacTupleHandler does not handle ${JSON.stringify((c as AuthzCommand).kind)}`, 'kind');
  return c;
}

function problemField(code: TupleProblem['code'], knownNamespace: boolean): string {
  if (code === 'subject_not_allowed') return 'tuple.subject';
  if (code === 'invalid_caveat_context') return 'tuple.caveat.context';
  return knownNamespace ? 'tuple.relation' : 'tuple.object';
}

/** DbTupleStore refuses these inside the transaction; refusing them here makes them a command error. */
function fitsColumns(t: Tuple, ctx: AdminContext): void {
  const s = t.subject;
  const values: [string, string, number][] = [
    ['tuple.object', t.object.type, TUPLE_COLUMN_WIDTHS.namespace],
    ['tuple.object', t.object.id!, TUPLE_COLUMN_WIDTHS.object_id],
    ['tuple.relation', t.relation, TUPLE_COLUMN_WIDTHS.relation],
    ['tuple.subject', subjectKey(s), TUPLE_COLUMN_WIDTHS.subject_key],
    ['tuple.subject', isSubjectSet(s) ? s.object.id! : s.id, TUPLE_COLUMN_WIDTHS.subject_id],
    ['tuple.caveat', t.caveat?.name ?? '', TUPLE_COLUMN_WIDTHS.caveat],
  ];
  for (const [field, value, width] of values) if (value.length > width) throw new AuthzAdminFailure('invalid_command', `${field} is longer than the authz_rebac_tuple column (${width})`, field);
  if (principalKey(actorRef(ctx)).length > TUPLE_COLUMN_WIDTHS.created_by) throw new AuthzAdminFailure('invalid_command', `the actor key is longer than the created_by column (${TUPLE_COLUMN_WIDTHS.created_by})`);
}

/**
 * tuple.write and tuple.delete on the domain's writable TupleStore (a MemoryTupleStore or DbTupleStore
 * registered as TupleStore), each tuple written checked against every RebacModel of the domain.
 */
@Singleton()
@Injectable(AuthzWriteHandler)
export class RebacTupleHandler extends AuthzWriteHandler {
  readonly kinds = ['tuple.write', 'tuple.delete'] as const;

  async validate(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    const command = tupleCommand(c);
    const tuple = commandTuple(command.tuple);
    const store = await writableStore(ctx);
    if (command.kind === 'tuple.delete') return;
    for (const model of rebacModels(ctx)) {
      const problem = model.schema().problem(tuple);
      if (!problem) continue;
      const field = problemField(problem.code, model.schema().namespaces.has(tuple.object.type));
      throw new AuthzAdminFailure(problem.code, `${model.name}: ${problem.message}`, field);
    }
    if (store instanceof DbTupleStore) fitsColumns(tuple, ctx);
  }

  permission(c: AuthzCommand): { permission: Permission; resource: ResourceRef } {
    const { object } = commandTuple(tupleCommand(c).tuple);
    return { permission: TUPLES_MANAGE, resource: { type: object.type, id: object.id } };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const command = tupleCommand(c);
    const tuple = commandTuple(command.tuple);
    const store = await writableStore(ctx);
    const write = command.kind === 'tuple.write';
    const { added, removed } = await writeTuples(store, tx, write ? [tuple] : [], write ? [] : [tuple], ctx);
    const affected = added.length + removed.length;
    if (affected === 0) return { affected: 0, tags: [], events: [] };
    // The stored tuples: a delete may omit the caveat the removed tuple had.
    const events = [...added.map((t) => tupleChanged(ctx, t, 'write')), ...removed.map((t) => tupleChanged(ctx, t, 'delete'))];
    return { affected, tags: tupleTags(ctx, [tuple.object.type]), events };
  }
}
