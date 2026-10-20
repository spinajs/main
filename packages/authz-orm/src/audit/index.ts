// `@spinajs/authz-orm/audit`: importing it registers the audit model and its migration, not the
// DecisionAudit (README, "Database audit"). Outside the API snapshot, as `./native` is.
export { DbDecisionAudit } from './db-audit.js';
export { AUDIT_CONNECTION, AUDIT_TABLE, AuthzAuditEntry } from './model.js';
export { AuthzAudit_2026_10_01_00_00_00 } from './AuthzAudit_2026_10_01_00_00_00.js';
