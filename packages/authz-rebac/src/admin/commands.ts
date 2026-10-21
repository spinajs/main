import type { ResourceRef } from '@spinajs/authz';

import type { Tuple, TupleSubject } from '../contracts.js';

/** Adds one tuple; one that is already stored is a no-op (`affected: 0`). */
export interface TupleWriteCommand {
  readonly kind: 'tuple.write';
  readonly tuple: Tuple;
}

/** Removes one tuple; a missing one is a no-op (`affected: 0`). */
export interface TupleDeleteCommand {
  readonly kind: 'tuple.delete';
  readonly tuple: Tuple;
}

export interface TuplesAdminQuery {
  readonly kind: 'tuples';
  /** The object (type and id) or a namespace (type only); absent: every tuple. */
  readonly scope?: ResourceRef;
  readonly relation?: string;
  readonly subject?: TupleSubject;
  readonly page?: { limit: number; offset: number; after?: string };
}

declare module '@spinajs/authz' {
  interface AuthzCommandMap {
    'tuple.write': TupleWriteCommand;
    'tuple.delete': TupleDeleteCommand;
  }

  interface AuthzAdminQueryMap {
    tuples: TuplesAdminQuery;
  }
}
