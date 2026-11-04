import type { TSESLint } from '@typescript-eslint/utils';

import { noRawRequest } from './rules/no-raw-request.js';
import { requireAccess } from './rules/require-access.js';
import { requireAccessible } from './rules/require-accessible.js';
import { requireHandlerAccess } from './rules/require-handler-access.js';
import { requireSocketAccess } from './rules/require-socket-access.js';

export { isAccessResourceClass, primaryKeyOf } from './access-resource.js';
export * from './rules/no-raw-request.js';
export * from './rules/require-access.js';
export * from './rules/require-accessible.js';
export * from './rules/require-handler-access.js';
export * from './rules/require-socket-access.js';

export const rules = {
  'require-accessible': requireAccessible,
  'require-access': requireAccess,
  'no-raw-request': noRawRequest,
  'require-socket-access': requireSocketAccess,
  'require-handler-access': requireHandlerAccess,
};

const plugin = { meta: { name: '@spinajs/eslint-plugin-authz' }, rules } satisfies TSESLint.FlatConfig.Plugin;

export const configs = {
  recommended: {
    name: '@spinajs/authz/recommended',
    plugins: { '@spinajs/authz': plugin },
    rules: {
      '@spinajs/authz/require-accessible': 'error',
      '@spinajs/authz/require-access': 'error',
      // 4.x: the server denies an unguarded socket handler, while an undeclared queue job only warns (errors in 5.0)
      '@spinajs/authz/require-socket-access': 'error',
      '@spinajs/authz/require-handler-access': 'warn',
    },
  } satisfies TSESLint.FlatConfig.Config,
};

export default { ...plugin, configs };
