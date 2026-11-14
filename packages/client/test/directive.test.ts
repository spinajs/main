import 'mocha';
import { expect } from 'chai';
import ts from 'typescript';
import { registerHooks } from 'node:module';
import type { Manifest } from '@spinajs/manifest';
import { generateClientFiles, type GeneratedFile } from '../src/index.js';
import { withUseClient } from '../src/generate/hooks/directive.js';
import { appBasicManifest } from './support/fixture.js';
import { libraryUrls, writeModules } from './support/modules.js';

// Section 3.1 of the frontend generators plan; each later emitter's files are already listed here.
const ENVIRONMENTS: Record<string, GeneratedFile['environment']> = {
  'client.ts': 'server-safe',
  'client.keys.ts': 'server-safe',
  'client.queries.ts': 'server-safe',
  'client.zod.ts': 'server-safe',
  'client.server.ts': 'server-safe',
  'client.next.ts': 'server-safe',
  'client.mocks.ts': 'server-safe',
  'client.msw.ts': 'server-safe',
  'client.react.ts': 'client',
  'client.react-query.ts': 'client',
  'client.swr.ts': 'client',
  'client.socket.ts': 'client',
  'client.socket-swr.ts': 'client',
};

function parse(file: GeneratedFile): ts.SourceFile {
  return ts.createSourceFile(file.path, file.contents, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function isUseClient(statement: ts.Statement | undefined): boolean {
  return !!statement && ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client';
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((s) => ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? [s.moduleSpecifier.text] : []));
}

describe("'use client' placement", () => {
  let files: GeneratedFile[];

  before(async () => {
    const manifest: Manifest = await appBasicManifest();
    files = await generateClientFiles({ manifest, hooks: ['react-query', 'swr'], zod: true, models: true, socketHooks: true });
  });

  it('marks every generated file with the environment section 3.1 gives it', () => {
    expect(files.map((f) => f.path)).to.include.members(['client.ts', 'client.keys.ts', 'client.react.ts', 'client.socket.ts', 'client.socket-swr.ts']);
    for (const file of files) expect([file.path, file.environment]).to.deep.equal([file.path, ENVIRONMENTS[file.path]]);
  });

  it("makes 'use client' the first statement of every client file, in the source and in the emitted JavaScript", () => {
    for (const file of files.filter((f) => f.environment === 'client')) {
      expect(isUseClient(parse(file).statements[0]), file.path).to.equal(true);
      const { outputText } = ts.transpileModule(file.contents, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
      const emitted = ts.createSourceFile('out.js', outputText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
      expect(isUseClient(emitted.statements[0]), `${file.path} emitted`).to.equal(true);
    }
  });

  it('keeps the query libraries out of every server-safe file except client.queries.ts', () => {
    for (const file of files.filter((f) => f.environment === 'server-safe' && f.path !== 'client.queries.ts')) {
      const libraries = moduleSpecifiers(parse(file)).filter((s) => s.startsWith('@tanstack/') || s === 'swr' || s.startsWith('swr/'));
      expect(libraries, file.path).to.deep.equal([]);
    }
  });

  it("keeps every server-safe file free of 'use client', of react and of imports from client files", () => {
    const clientModules = new Set(files.filter((f) => f.environment === 'client').map((f) => `./${f.path.replace(/\.ts$/, '.js')}`));
    for (const file of files.filter((f) => f.environment === 'server-safe')) {
      const sourceFile = parse(file);
      expect(sourceFile.statements.filter(isUseClient), file.path).to.deep.equal([]);
      const specifiers = moduleSpecifiers(sourceFile);
      expect(specifiers.filter((s) => s === 'react' || s.startsWith('react/') || clientModules.has(s)), file.path).to.deep.equal([]);
    }
  });

  it('loads client.keys.js in plain Node while react cannot be resolved, as the server side of an RSC import does', async () => {
    const generated = Object.fromEntries(files.filter((f) => f.path === 'client.keys.ts' || f.path === 'client.react.ts').map((f) => [f.path, f.contents]));
    const modules = writeModules(generated, libraryUrls(['react']));
    const noReact = registerHooks({
      resolve: (specifier, context, next) => {
        const resolved = next(specifier, context);
        if (/\/node_modules\/react\//.test(resolved.url)) throw Object.assign(new Error(`Cannot find package 'react' imported from ${context.parentURL}`), { code: 'ERR_MODULE_NOT_FOUND' });
        return resolved;
      },
    });
    try {
      const { appKeys } = await modules.import<{ appKeys: { users: { get(vars: { id: number }): unknown } } }>('client.keys.js');
      expect(appKeys.users.get({ id: 7 })).to.deep.equal(['spinajs', 'users', 'get', { id: 7 }]);
      // The hook is what keeps react out: the client file next to it fails to load.
      const error = await modules.import('client.react.js').catch((e: unknown) => e);
      expect(error).to.have.property('code', 'ERR_MODULE_NOT_FOUND');
    } finally {
      noReact.deregister();
      modules.remove();
    }
  });

  describe('withUseClient', () => {
    it('puts the directive after the header comment', () => {
      expect(withUseClient("/* header */\nimport { a } from 'a';\n")).to.equal("/* header */\n'use client';\nimport { a } from 'a';\n");
    });

    it('puts the directive first when there is no header comment', () => {
      expect(withUseClient("import { a } from 'a';\n")).to.equal("'use client';\nimport { a } from 'a';\n");
    });
  });
});
