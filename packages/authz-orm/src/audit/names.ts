// Apart from model.ts so the CLI can name the table without registering the audit model.
/** The connection name of the audit table; map it to a real connection with `db.Aliases`. */
export const AUDIT_CONNECTION = 'authz-audit';
export const AUDIT_TABLE = 'authz_audit';
