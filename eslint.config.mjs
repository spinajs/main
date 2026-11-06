// Existing violations live in eslint-suppressions.json, so only new errors fail `npm run lint`.
// After fixing old ones run `npm run lint:prune`; never regenerate the file to hide new ones.
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import promise from 'eslint-plugin-promise';
import security from 'eslint-plugin-security';
import tsdoc from 'eslint-plugin-tsdoc';
import authz from '@spinajs/eslint-plugin-authz';
import orm from '@spinajs/eslint-plugin-orm';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/*.d.ts',
      '**/test/fixtures/**',
      // A Vite + ckit app: its @coderush/* imports only resolve where ckit is linked; its own typecheck covers it.
      'packages/studio-ui/**',
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
      // Flags the open endpoints of existing controllers (login, metrics) and many test fixtures; opt in per package once they carry @AllowAnonymous.
      '@spinajs/authz/require-access': 'off',
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
    // Every authn/authz route input goes through route-argument validation (input-validation plan D12).
    files: ['packages/{authn,authz}*/src/**/*.ts'],
    rules: { '@spinajs/authz/no-raw-request': 'error' },
  },
  {
    // The O6 strict packages. typed-sql checks only files with an app.manifest.json between them and their package.json, which a library has not, so this is inert until one is built (A15).
    files: ['packages/{scheduler,authz-rbac,authn-orm,upload,users,users-http,teams,authn-token,session-provider-db,authz-orm,authz-rebac,authn-webauthn,email-verification-orm,orm-http,orm-threading}/src/**/*.ts'],
    plugins: { '@spinajs/orm': orm },
    rules: { '@spinajs/orm/typed-sql': 'error' },
  },
  {
    // The one place the rule runs against a real app manifest in this repo: the plugin's fixture app, manifest named explicitly.
    // Typed rules off, the authz one included: the plugin's tsconfig.json excludes test/fixtures, so projectService has no program for this file.
    files: ['packages/eslint-plugin-orm/test/fixtures/app/src/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    plugins: { '@spinajs/orm': orm },
    rules: { '@spinajs/orm/typed-sql': ['error', { manifest: 'packages/eslint-plugin-orm/test/fixtures/app/app.manifest.json' }], '@spinajs/authz/require-accessible': 'off' },
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
