import { PERMISSION_MAX_LENGTH, permissionField } from '@spinajs/authz';
import { Query } from '@spinajs/http';

/** `<type>:<id>`: a 64 character type, a 160 character id and the colon fit. */
const EXPLAIN_KEY_MAX_LENGTH = 256;

const key = { type: 'string', minLength: 1, maxLength: EXPLAIN_KEY_MAX_LENGTH } as const;

export const EXPLAIN_QUERY_PROPERTIES = Object.freeze({
  principal: key,
  permission: { ...permissionField, minLength: 1, maxLength: PERMISSION_MAX_LENGTH },
  resource: { type: 'string', maxLength: EXPLAIN_KEY_MAX_LENGTH },
  format: { enum: ['', 'decision', 'tree'] },
});

/** `GET /authz/explain` query; each member is validated as its own `@Query()` argument. */
export interface ExplainQuery {
  readonly principal: string;
  readonly permission: string;
  readonly resource?: string;
  readonly format?: 'decision' | 'tree' | '';
}

export function ExplainQueryArg(name: keyof ExplainQuery): ReturnType<typeof Query> {
  return Query(EXPLAIN_QUERY_PROPERTIES[name], { required: name === 'principal' || name === 'permission' });
}
