import { requireAccessible } from './rules/require-accessible.js';

export { isAccessResourceClass, primaryKeyOf } from './access-resource.js';
export * from './rules/require-accessible.js';

// ESLint 8 reads `rules` and `configs` off the module it requires (lib/cjs).
export const rules = {
  'require-accessible': requireAccessible,
};

export const configs = {
  recommended: {
    plugins: ['@spinajs/authz'],
    rules: { '@spinajs/authz/require-accessible': 'error' },
  },
};
