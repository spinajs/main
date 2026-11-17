import { WORKFLOW_STATUSES } from '@spinajs/workflow';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

const status = `(${WORKFLOW_STATUSES.join('|')})`;
/** `status=running,waiting`. */
export const STATUS_LIST_SCHEMA = { type: 'string', pattern: `^${status}(,${status})*$` };
export const INSTANCE_ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 };
export const WORKFLOW_NAME_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 };
