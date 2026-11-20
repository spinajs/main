// The root config ignores this package: its @coderush/* imports resolve only where ckit is linked, and typed rules
// report every use of an import that does not resolve. This file lints the package there and nothing elsewhere.
import { existsSync } from 'node:fs';
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import promise from 'eslint-plugin-promise';
import tseslint from 'typescript-eslint';

const ckitLinked = existsSync(new URL('../../node_modules/@coderush/ckit-components/package.json', import.meta.url));

export default defineConfig(
  { ignores: ckitLinked ? ['dist/**'] : ['**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts', 'vitest.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked, promise.configs['flat/recommended']],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ group: ['@spinajs/*'], allowTypeImports: true, message: 'Server packages are imported for their types only: nothing of them may reach the browser bundle.' }] }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      complexity: ['error', { max: 15 }],
      'max-depth': ['error', 4],
      'max-nested-callbacks': ['error', 3],
    },
  },
);
