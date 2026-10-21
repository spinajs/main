import type { AuthzAdminOptions } from '@spinajs/authz';

import { batchOf } from '../schemas/primitives.js';

/** POST /authz/commands without the per-kind command schemas: those come from AuthzCommandSchemaRegistry at request time. */
export const BATCH_ENVELOPE_SCHEMA = {
  $id: 'authz.admin.batch',
  ...batchOf({ type: 'object', required: ['kind'], properties: { kind: { type: 'string', minLength: 1, maxLength: 128 } } }),
};

/** The validated body of POST /authz/commands, its expiry dates read as Dates. */
export interface AuthzAdminCommandBatch {
  readonly commands: readonly unknown[];
  readonly options: AuthzAdminOptions;
}
