export const CHANGE_LOG_TABLE = 'authz_change_log';
export const POLICY_VERSION_TABLE = 'authz_policy_version';
export const HORIZON_TABLE = 'authz_change_log_horizon';

/** Widths of the authz_change_log columns an entry fills. */
export const CHANGE_LOG_WIDTHS = Object.freeze({ kind: 16, op: 8, key: 255, actor: 100, trace_id: 32 });

/** Widths of the authz_change_log_horizon key columns. */
export const HORIZON_WIDTHS = Object.freeze({ kind: 16, resource_type: 64 });
