import type { TSESLint } from '@typescript-eslint/utils';

import { typedSql } from './rules/typed-sql.js';

export * from './rules/typed-sql.js';

export const rules = {
  'typed-sql': typedSql,
};

const plugin = { meta: { name: '@spinajs/eslint-plugin-orm' }, rules } satisfies TSESLint.FlatConfig.Plugin;

export const configs = {
  recommended: {
    name: '@spinajs/orm/recommended',
    plugins: { '@spinajs/orm': plugin },
    rules: { '@spinajs/orm/typed-sql': 'error' },
  } satisfies TSESLint.FlatConfig.Config,
};

export default { ...plugin, configs };
