import { fieldSchema, idField, typeField } from '@spinajs/authz';

/** `:id` of a row route (assignment, link, rule, policy) or of a scope node. */
export const ID_PARAM = fieldSchema('authz.admin.param.id', { ...idField, description: 'the id of the row (assignment, link, rule, policy) or of the scope node' });

/** `:type` of a scope node. */
export const TYPE_PARAM = fieldSchema('authz.admin.param.type', { ...typeField, description: 'the resource type of the scope node' });
