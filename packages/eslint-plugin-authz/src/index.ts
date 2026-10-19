import type { TSESLint } from '@typescript-eslint/utils';

import { requireAccessible } from './rules/require-accessible.js';

export { isAccessResourceClass, primaryKeyOf } from './access-resource.js';
export * from './rules/require-accessible.js';

export const rules = {
  'require-accessible': requireAccessible,
};

const plugin = { meta: { name: '@spinajs/eslint-plugin-authz' }, rules } satisfies TSESLint.FlatConfig.Plugin;

export const configs = {
  recommended: {
    name: '@spinajs/authz/recommended',
    plugins: { '@spinajs/authz': plugin },
    rules: { '@spinajs/authz/require-accessible': 'error' },
  } satisfies TSESLint.FlatConfig.Config,
};

export default { ...plugin, configs };
