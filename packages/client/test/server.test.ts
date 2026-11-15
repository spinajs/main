import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Manifest } from '@spinajs/manifest';
import { generateClient, generateClientFiles, type GenerateClientFilesOptions } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { writeModules } from './support/modules.js';
import { typecheckFiles } from './support/typecheck.js';

async function serverFiles(manifest: Manifest, options: Partial<GenerateClientFilesOptions> = {}): Promise<Record<string, string>> {
  const files = await generateClientFiles({ manifest, server: true, ...options });
  return Object.fromEntries(files.map((f) => [f.path, f.contents]));
}

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));

function matchSnapshot(name: string, contents: string): void {
  if (!existsSync(snapshot(name))) writeFileSync(snapshot(name), contents);
  expect(contents).to.equal(readFileSync(snapshot(name), 'utf8'));
}

function imports(contents: string): string[] {
  const source = ts.createSourceFile('x.ts', contents, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return source.statements.flatMap((s) => (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) ? [s.moduleSpecifier.text] : []));
}

const typedApp = [
  "import { createServerAppClient, type ServerAppClientOptions } from './client.server.js';",
  "import type { AppClient, UserDto } from './client.js';",
  '',
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
  '',
  'export async function load(incoming: Headers, record: Record<string, string | string[] | undefined>): Promise<UserDto> {',
  "  const fromHeaders: AppClient = createServerAppClient({ baseUrl: 'http://api', incoming });",
  "  createServerAppClient({ baseUrl: 'http://api', incoming: record, forward: ['cookie', 'x-tenant'], headers: { 'x-app': '1' } });",
  "  createServerAppClient({ baseUrl: 'http://api', incoming: { get: (name: string) => (name === 'cookie' ? 'a=1' : null) }, headers: async () => ({}) });",
  "  createServerAppClient({ baseUrl: 'http://api', fetch: globalThis.fetch, onProblem: () => undefined });",
  "  // @ts-expect-error credentials mean nothing to a server's fetch",
  "  createServerAppClient({ baseUrl: 'http://api', credentials: 'include' });",
  '  // @ts-expect-error baseUrl is required',
  '  createServerAppClient({ incoming });',
  "  const check: Equal<ReturnType<typeof createServerAppClient>, AppClient> = true;",
  "  const options: ServerAppClientOptions = { baseUrl: 'http://api' };",
  '  void [check, options];',
  '  return fromHeaders.users.get(1);',
  '}',
  '',
].join('\n');

describe('server client emitter', () => {
  let manifest: Manifest;
  let files: Record<string, string>;

  before(async () => {
    manifest = await appBasicManifest();
    files = await serverFiles(manifest);
  });

  it('matches the committed snapshot of client.server.ts', async () => {
    const named = await serverFiles(manifest, { basename: 'app-basic.client' });
    matchSnapshot('app-basic.client.server.ts', named['app-basic.client.server.ts']);
  });

  it('writes client.ts and a server-safe client.server.ts, without needing hooks', async () => {
    const generated = await generateClientFiles({ manifest, server: true });
    expect(generated.map((f) => [f.path, f.environment])).to.deep.equal([
      ['client.ts', 'server-safe'],
      ['client.server.ts', 'server-safe'],
    ]);
    expect(generated[0].contents.replace(`export const manifestHash = '${manifest.hash}';\n\n`, '')).to.equal(await generateClient({ manifest }));
  });

  it("has no 'use client' and imports only the runtime and client.ts: no React, no query library", () => {
    expect(files['client.server.ts']).to.not.include('use client');
    expect(imports(files['client.server.ts'])).to.deep.equal(['@spinajs/client/runtime', './client.js']);
  });

  it('follows basename and moduleName', async () => {
    const named = await serverFiles(manifest, { basename: 'api', moduleName: './runtime.js' });
    expect(Object.keys(named)).to.deep.equal(['api.ts', 'api.server.ts']);
    expect(imports(named['api.server.ts'])).to.deep.equal(['./runtime.js', './api.js']);
  });

  it('writes the same file next to the hooks files', async () => {
    const withHooks = await serverFiles(manifest, { hooks: ['react-query', 'swr'] });
    expect(Object.keys(withHooks)).to.include('client.server.ts');
    expect(withHooks['client.server.ts']).to.equal(files['client.server.ts']);
  });

  it('type-checks strictly, with the options and the return type an app relies on', () => {
    expect(typecheckFiles({ ...files, 'app.ts': typedApp }, { noUnusedLocals: true, noUnusedParameters: true })).to.deep.equal([]);
  });

  it('fails to compile against a client.ts generated from another manifest', () => {
    const stale = files['client.ts'].replace(`manifestHash = '${manifest.hash}'`, "manifestHash = 'other'");
    expect(typecheckFiles({ ...files, 'client.ts': stale }).filter((e) => e.startsWith('client.server.ts: '))).to.have.length(1);
  });

  it('calls the absolute baseUrl with the forwarded headers and without the incoming host', async () => {
    const modules = writeModules(await serverFiles(manifest, { includeSocket: false }), { '@spinajs/client/runtime': import.meta.resolve('@spinajs/client/runtime') });
    try {
      const { createServerAppClient } = await modules.import<{ createServerAppClient: (options: object) => { users: { get(id: number): Promise<unknown> } } }>('client.server.js');
      const seen: { url: string; headers: Record<string, string> }[] = [];
      const fetch = (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> });
        return Promise.resolve(Response.json({ id: 1 }));
      };
      const incoming = { cookie: 'session=abc', authorization: 'Bearer t', host: 'evil.example', 'x-forwarded-for': '10.0.0.1', connection: 'close', 'content-length': '3' };
      const client = createServerAppClient({ baseUrl: 'http://api.internal/v1/', incoming, fetch, headers: { 'x-app': '1' } });
      expect(await client.users.get(1)).to.deep.equal({ id: 1 });
      expect(seen).to.deep.equal([{ url: 'http://api.internal/v1/users/1', headers: { accept: 'application/json, application/problem+json', cookie: 'session=abc', authorization: 'Bearer t', 'x-app': '1' } }]);
      expect(() => createServerAppClient({ baseUrl: '/v1', incoming })).to.throw(TypeError);
    } finally {
      modules.remove();
    }
  });
});
