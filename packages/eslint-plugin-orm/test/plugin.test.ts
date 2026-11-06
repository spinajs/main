import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { configs, rules } from '../src/index.js';

const app = fileURLToPath(new URL('./fixtures/app', import.meta.url));

describe('@spinajs/eslint-plugin-orm', () => {
  it('exports the rule and a recommended config that enables it', () => {
    expect(Object.keys(rules)).to.deep.eq(['typed-sql']);
    expect(Object.keys(plugin.rules)).to.deep.eq(['typed-sql']);
    expect(plugin.configs.recommended).to.eq(configs.recommended);
    expect(configs.recommended.rules).to.deep.eq({ '@spinajs/orm/typed-sql': 'error' });
  });

  it('fixes through ESLint and the fixed file lints clean', async () => {
    const eslint = new ESLint({
      cwd: app,
      fix: true,
      overrideConfigFile: true,
      // typescript-eslint's FlatConfig types and ESLint's own Linter.Config differ only in index signatures.
      overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, configs.recommended as unknown as Linter.Config],
    });

    const [result] = await eslint.lintText("import { sql } from '@spinajs/orm';\nexport const q = sql`SELECT Id, Email FROM users`;\n", { filePath: `${app}/src/queries.ts` });

    expect(result.output).to.equal("import { sql } from '@spinajs/orm';\nexport const q = sql<{ Id: number; Email: string }>`SELECT Id, Email FROM users`;\n");
    expect(result.messages).to.deep.equal([]);
  });

  // ESLint re-lints after each fix pass. The fixed row is newer than the manifest's `declaredColumns`, so the second pass must not re-fire SQL005 (A13).
  it('the SQL005 fix round-trips: the rewritten row is not checked against the stale manifest', async () => {
    const eslint = new ESLint({
      cwd: app,
      fix: true,
      overrideConfigFile: true,
      overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, configs.recommended as unknown as Linter.Config],
    });

    const [result] = await eslint.lintText("import { sql } from '@spinajs/orm';\n\n\nexport const q = sql<{ Name: string }>`SELECT Name FROM users`;\n", { filePath: `${app}/src/queries.ts` });

    expect(result.output).to.equal("import { sql } from '@spinajs/orm';\n\n\nexport const q = sql<{ Name: string | null }>`SELECT Name FROM users`;\n");
    expect(result.messages).to.deep.equal([]);
  });
});
