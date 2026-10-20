import type { Assignment } from '@spinajs/authz';

import { parsePrincipalKey, scopeFromColumns, subjectFromColumns } from './columns.js';
import { fromDateTime } from './records.js';
import type { AssignmentFields } from './records.js';
import { parseTags } from './tags.js';

/** `tags` is left out when there are none; `expiresAt` is always present (`null` when the column is). */
export function rowToAssignment(row: AssignmentFields): Assignment {
  const tags = parseTags(row.tags);
  const grantedBy = parsePrincipalKey(row.granted_by);

  return {
    id: row.id,
    subject: subjectFromColumns(row.subject_type, row.subject_id, row.subject_role),
    role: row.role,
    scope: scopeFromColumns(row.scope_type, row.scope_id),
    ...(tags.length > 0 ? { tags } : {}),
    expiresAt: fromDateTime(row.expires_at),
    ...(grantedBy ? { grantedBy } : {}),
    source: row.source,
  };
}
