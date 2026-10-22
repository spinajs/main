import type { TSESLint } from '@typescript-eslint/utils';

import { noRawRequest } from './rules/no-raw-request.js';
import { requireAccess } from './rules/require-access.js';
import { requireAccessible } from './rules/require-accessible.js';

export { isAccessResourceClass, primaryKeyOf } from './access-resource.js';
export * from './rules/no-raw-request.js';
export * from './rules/require-access.js';
export * from './rules/require-accessible.js';

export const rules = {
  'require-accessible': requireAccessible,
  'require-access': requireAccess,
  'no-raw-request': noRawRequest,
};

const plugin = { meta: { name: '@spinajs/eslint-plugin-authz' }, rules } satisfies TSESLint.FlatConfig.Plugin;

export const configs = {
  recommended: {
    name: '@spinajs/authz/recommended',
    plugins: { '@spinajs/authz': plugin },
    rules: { '@spinajs/authz/require-accessible': 'error', '@spinajs/authz/require-access': 'error' },
  } satisfies TSESLint.FlatConfig.Config,
};

export default { ...plugin, configs };
