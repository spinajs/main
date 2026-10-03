import type { Assignment } from '@spinajs/authz';

import { parsePrincipalKey, scopeFromColumns, subjectFromColumns, toDate } from './columns.js';
import { parseTags } from './tags.js';

export { AUTHZ_ASSIGNMENT_TABLE } from '../orm/rbac-orm-compiler.js';

/** One `authz_assignment` row as the drivers return it (datetimes are text on SQLite). */
export interface AssignmentRow {
  id: string;
  subject_type: string;
  subject_id: string;
  subject_role: string;
  role: string;
  scope_type: string;
  scope_id: string;
  tags: string;
  expires_at: Date | string | null;
  granted_by: string | null;
  source: string;
  created_at: Date | string;
}

/** `tags` is left out when there are none; `expiresAt` is always present (`null` when the column is). */
export function rowToAssignment(row: AssignmentRow): Assignment {
  const tags = parseTags(row.tags);
  const grantedBy = parsePrincipalKey(row.granted_by);

  return {
    id: row.id,
    subject: subjectFromColumns(row.subject_type, row.subject_id, row.subject_role),
    role: row.role,
    scope: scopeFromColumns(row.scope_type, row.scope_id),
    ...(tags.length > 0 ? { tags } : {}),
    expiresAt: toDate(row.expires_at),
    ...(grantedBy ? { grantedBy } : {}),
    source: row.source,
  };
}
