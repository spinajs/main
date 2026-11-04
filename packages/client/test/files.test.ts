import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, generateClient, generateClientFiles, GENERATOR_TARGETS, requestedTargets, type GenerateClientFilesOptions } from '../src/index.js';
import { emitClient } from '../src/generate.js';
import { assertUniquePaths } from '../src/generate/files.js';
import { appBasicManifest } from './support/fixture.js';
import { typecheck } from './support/typecheck.js';

describe('generateClientFiles', () => {
  let manifest: Manifest;
  let client: string;

  before(async () => {
    manifest = await appBasicManifest();
    client = await generateClient({ manifest });
  });

  it('returns exactly one file equal to generateClient without companion options', async () => {
    expect(await generateClientFiles({ manifest })).to.deep.equal([{ path: 'client.ts', environment: 'server-safe', contents: client }]);
  });

  it('passes the client options through and names the file after basename', async () => {
    const files = await generateClientFiles({ manifest, basename: 'api', moduleName: './runtime.js', includeSocket: false });
    expect(files).to.deep.equal([{ path: 'api.ts', environment: 'server-safe', contents: await generateClient({ manifest, moduleName: './runtime.js', includeSocket: false }) }]);
  });

  it('keeps client.ts unchanged for options that only shape companion files', async () => {
    const files = await generateClientFiles({ manifest, models: false, socketHooks: false, keyPrefix: 'app', zod: false, hooks: [] });
    expect(files).to.have.length(1);
    const [file] = files;
    expect(file.contents).to.equal(client);
  });

  const companions: [Partial<GenerateClientFilesOptions>, string[]][] = [
    [{ zod: true }, ['client.ts']],
    [{ zod: { mini: true } }, ['client.ts']],
    [{ hooks: ['react-query'] }, ['client.ts', 'client.keys.ts', 'client.react.ts', 'client.queries.ts', 'client.react-query.ts']],
    [{ hooks: ['swr'] }, ['client.ts', 'client.keys.ts', 'client.react.ts', 'client.swr.ts']],
    [{ hooks: ['react-query', 'swr'] }, ['client.ts', 'client.keys.ts', 'client.react.ts', 'client.queries.ts', 'client.react-query.ts', 'client.swr.ts']],
    [{ hooks: ['react-query'], socketHooks: true }, ['client.ts', 'client.keys.ts', 'client.react.ts', 'client.queries.ts', 'client.react-query.ts', 'client.socket.ts']],
    [{ hooks: ['swr'], socketHooks: true }, ['client.ts', 'client.keys.ts', 'client.react.ts', 'client.swr.ts', 'client.socket.ts', 'client.socket-swr.ts']],
  ];
  for (const [companion, paths] of companions) {
    it(`exports manifestHash from client.ts when a companion is requested (${JSON.stringify(companion)})`, async () => {
      const files = await generateClientFiles({ manifest, ...companion });
      expect(files.map((f) => f.path)).to.deep.equal(paths);
      const [file] = files;
      expect(file.path).to.equal('client.ts');
      const hashLine = `export const manifestHash = '${manifest.hash}';\n\n`;
      expect(file.contents).to.include(hashLine);
      expect(file.contents.replace(hashLine, '')).to.equal(client);
      expect(typecheck(file.contents)).to.deep.equal([]);
    });
  }

  it('prints client.ts from one model twice with the same result and the same schema set', async () => {
    const model = buildClientModel(manifest);
    const schemas = [...model.ctx.used];
    expect(await emitClient(model)).to.equal(client);
    expect(await emitClient(model)).to.equal(client);
    expect([...model.ctx.used]).to.deep.equal(schemas);
  });

  it('lists every generator target with whether its emitter has landed', () => {
    expect(GENERATOR_TARGETS).to.deep.equal({
      'react-query': { available: true },
      swr: { available: true },
      zod: { available: false },
      models: { available: false },
      'socket-hooks': { available: true },
    });
  });

  it('names the targets the options request, in table order whatever the flag order', () => {
    expect(requestedTargets({ manifest })).to.deep.equal([]);
    expect(requestedTargets({ manifest, hooks: ['swr', 'react-query'], zod: { mini: true }, models: true, socketHooks: true, keyPrefix: 'x' })).to.deep.equal(['react-query', 'swr', 'zod', 'models', 'socket-hooks']);
    expect(requestedTargets({ manifest, hooks: [], zod: false, models: false, socketHooks: false })).to.deep.equal([]);
  });

  it('refuses two files at the same path, which two emitters would otherwise both return', () => {
    const file = (path: string) => ({ path, environment: 'server-safe' as const, contents: '' });
    expect(() => assertUniquePaths([file('client.ts'), file('client.keys.ts')])).to.not.throw();
    expect(() => assertUniquePaths([file('client.ts'), file('client.keys.ts'), file('client.keys.ts')])).to.throw('generateClientFiles: two emitters write client.keys.ts');
  });

  const rejections: [string, Partial<GenerateClientFilesOptions>, string][] = [
    ['an unknown hooks target, naming the allowed ones', { hooks: ['react-query', 'vue' as 'swr'] }, "generateClientFiles: unknown hooks target 'vue'; use react-query or swr"],
    ['a hooks target listed twice', { hooks: ['swr', 'react-query', 'swr'] }, "generateClientFiles: hooks target 'swr' is listed twice"],
    ['socketHooks without hooks', { socketHooks: true }, 'generateClientFiles: socketHooks needs hooks, which pick the flavour of the socket hooks'],
  ];
  for (const [what, options, message] of rejections) {
    it(`rejects ${what}`, async () => {
      const error = await generateClientFiles({ manifest, ...options }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal(message);
    });
  }
});
