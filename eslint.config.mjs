// Existing violations live in eslint-suppressions.json, so only new errors fail `npm run lint`.
// After fixing old ones run `npm run lint:prune`; never regenerate the file to hide new ones.
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import promise from 'eslint-plugin-promise';
import security from 'eslint-plugin-security';
import tsdoc from 'eslint-plugin-tsdoc';
import authz from '@spinajs/eslint-plugin-authz';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/*.d.ts',
      '**/test/fixtures/**',
      // Their tsconfig.json does not include test/, so the typed rules have no program for it.
      'packages/{di,exceptions,fs-onedrive,orm-threading,session-provider-redis,templates-csv,threading,util}/test/**',
    ],
  },
  {
    files: ['packages/*/{src,test}/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked, promise.configs['flat/recommended'], security.configs.recommended, authz.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { tsdoc },
    rules: {
      'tsdoc/syntax': 'warn',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Abstract DI tokens are typed as the service, yet resolve to a promise when the registered implementation is an AsyncService.
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'security/detect-unsafe-regex': 'off',
    },
  },
  {
    files: ['packages/*/test/**/*.ts'],
    rules: {
      // chai assertions are property reads: expect(x).to.be.true
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      complexity: ['error', { max: 15 }],
      'max-depth': ['error', 4],
      'max-nested-callbacks': ['error', 3],
    },
  },
);
