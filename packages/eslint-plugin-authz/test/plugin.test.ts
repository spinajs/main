import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { TSESLint } from '@typescript-eslint/utils';

import * as plugin from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('@spinajs/eslint-plugin-authz', () => {
  it('exports the rule and a recommended config that enables it', () => {
    expect(Object.keys(plugin.rules)).to.deep.eq(['require-accessible']);
    expect(plugin.configs.recommended.rules).to.deep.eq({ '@spinajs/authz/require-accessible': 'error' });
  });

  it('reports through ESLint with plugin:@spinajs/authz/recommended', async () => {
    // The repo has no @types/eslint; TSESLint.ESLint is the typed wrapper. Its v5 ConfigOverride type
    // wrongly requires `files`, which ESLint 8 refuses at the top level, hence the cast.
    const eslint = new TSESLint.ESLint({
      cwd: fixtures,
      useEslintrc: false,
      plugins: { '@spinajs/authz': plugin as unknown as TSESLint.Linter.Plugin },
      overrideConfig: {
        parser: '@typescript-eslint/parser',
        parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixtures, sourceType: 'module' },
        extends: ['plugin:@spinajs/authz/recommended'],
      } as unknown as TSESLint.ESLint.ESLintOptions['overrideConfig'],
    });

    const [result] = await eslint.lintText("import { Task } from './models';\nexport const run = () => Task.where('a', 1).first();\n", { filePath: `${fixtures}/file.ts` });

    expect(result.messages.map((m) => [m.ruleId, m.line])).to.deep.eq([['@spinajs/authz/require-accessible', 2]]);
    expect(result.messages[0].message).to.match(/^Task is an @AccessResource model: this query reaches \.first\(\)/);
  });
});
