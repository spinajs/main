import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { configs, rules } from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('@spinajs/eslint-plugin-authz', () => {
  it('exports the rule and a recommended config that enables it', () => {
    expect(Object.keys(rules)).to.deep.eq(['require-accessible', 'require-access']);
    expect(Object.keys(plugin.rules)).to.deep.eq(['require-accessible', 'require-access']);
    expect(plugin.configs.recommended).to.eq(configs.recommended);
    expect(configs.recommended.rules).to.deep.eq({ '@spinajs/authz/require-accessible': 'error', '@spinajs/authz/require-access': 'error' });
  });

  it('reports through ESLint with the recommended flat config', async () => {
    const eslint = new ESLint({
      cwd: fixtures,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixtures } },
        },
        // typescript-eslint's FlatConfig types and ESLint's own Linter.Config differ only in index signatures.
        configs.recommended as unknown as Linter.Config,
      ],
    });

    const [result] = await eslint.lintText("import { Task } from './models';\nexport const run = () => Task.where('a', 1).first();\n", { filePath: `${fixtures}/file.ts` });

    expect(result.messages.map((m) => [m.ruleId, m.line])).to.deep.eq([['@spinajs/authz/require-accessible', 2]]);
    expect(result.messages[0].message).to.match(/^Task is an @AccessResource model: this query reaches \.first\(\)/);
  });
});
