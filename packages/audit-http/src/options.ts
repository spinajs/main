/** `audit.http`, and the options of `@Middleware(Audit, options)`. */
export interface IAuditOptions {
  /** HTTP methods audited; unset audits every method. */
  methods?: string[];
  /** Keys whose values are never recorded, matched as case-insensitive substrings. Route options add to the configured list. */
  redact?: string[];
  /** Whether the request body is recorded. Default `true`. */
  includeBody?: boolean;
  /** A body larger than this, as JSON after redaction, is left out and only its size recorded. Default 16384. */
  maxBodyBytes?: number;
  /** The audit trail the events are written to. Default `default`. */
  trail?: string;
  /** The action of the events. Default the route name, `http:<METHOD> <mounted path>`. Set for several routes at once (a controller, a global entry, `audit.http`) it is a prefix: `<action>.<method name>`. */
  action?: string;
}

export const DEFAULT_AUDIT_REDACT = ['password', 'token', 'secret', 'authorization', 'cookie', 'card'];
export const DEFAULT_MAX_BODY_BYTES = 16384;
