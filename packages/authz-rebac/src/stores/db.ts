import type { AuthzTx, PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

import { TupleStore } from '../contracts.js';
import type { Tuple, TuplePage, TupleQuery, TupleSubject } from '../contracts.js';

export const AUTHZ_REBAC_TUPLE_TABLE = 'authz_rebac_tuple';

/** Widths of the authz_rebac_tuple columns a tuple fills. */
export const TUPLE_COLUMN_WIDTHS = Object.freeze({ namespace: 64, object_id: 128, relation: 64, subject_key: 320, subject_type: 64, subject_id: 128, created_by: 100 });

/**
 * `TupleStore` over `authz_rebac_tuple` on the ORM connection alias `authz`. `write` runs in its own
 * transaction; `writeIn` joins the transaction of an `AuthzAdmin` command.
 */
export class DbTupleStore extends TupleStore {
  readonly name: string = 'db';

  async read(_object: ResourceRef, _relation: string): Promise<readonly Tuple[]> {
    throw new Error('not implemented: DbTupleStore.read');
  }

  async reverse(_subject: TupleSubject, _relation: string, _objectType: ResourceType): Promise<readonly ResourceRef[]> {
    throw new Error('not implemented: DbTupleStore.reverse');
  }

  async reverseMany(_subjects: readonly TupleSubject[], _relation: string, _objectType: ResourceType): Promise<readonly ResourceRef[]> {
    throw new Error('not implemented: DbTupleStore.reverseMany');
  }

  async write(_add: readonly Tuple[], _remove: readonly Tuple[], _actor: PrincipalRef): Promise<string> {
    throw new Error('not implemented: DbTupleStore.write');
  }

  /** The tuples it actually added and removed, inside `tx`. */
  async writeIn(_tx: AuthzTx, _add: readonly Tuple[], _remove: readonly Tuple[], _actor: PrincipalRef, _now?: Date): Promise<{ readonly added: number; readonly removed: number }> {
    throw new Error('not implemented: DbTupleStore.writeIn');
  }

  async find(_query: TupleQuery, _page?: TuplePage): Promise<{ readonly items: readonly Tuple[]; readonly total: number }> {
    throw new Error('not implemented: DbTupleStore.find');
  }
}
