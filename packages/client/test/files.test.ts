import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, generateClient, generateClientFiles, GENERATOR_TARGETS, requestedTargets, type GenerateClientFilesOptions } from '../src/index.js';
import { emitClient } from '../src/generate.js';
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
    expect(await generateClientFiles({ manifest })).to.deep.equal([{ path: 'client.ts', contents: client }]);
  });

  it('passes the client options through and names the file after basename', async () => {
    const files = await generateClientFiles({ manifest, basename: 'api', moduleName: './runtime.js', includeSocket: false });
    expect(files).to.deep.equal([{ path: 'api.ts', contents: await generateClient({ manifest, moduleName: './runtime.js', includeSocket: false }) }]);
  });

  it('keeps client.ts unchanged for options that only shape companion files', async () => {
    const files = await generateClientFiles({ manifest, models: false, socketHooks: false, keyPrefix: 'app', zod: false, hooks: [] });
    expect(files).to.have.length(1);
    const [file] = files;
    expect(file.contents).to.equal(client);
  });

  for (const companion of [{ zod: true }, { zod: { mini: true } }, { hooks: ['react-query'] }, { hooks: ['swr'] }] as Partial<GenerateClientFilesOptions>[]) {
    it(`exports manifestHash from client.ts when a companion is requested (${JSON.stringify(companion)})`, async () => {
      const files = await generateClientFiles({ manifest, ...companion });
      expect(files).to.have.length(1);
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
      'react-query': { available: false },
      swr: { available: false },
      zod: { available: false },
      models: { available: false },
      'socket-hooks': { available: false },
      server: { available: false },
      next: { available: false },
      mocks: { available: false },
      msw: { available: false },
    });
  });

  it('names the targets the options request', () => {
    expect(requestedTargets({ manifest })).to.deep.equal([]);
    expect(requestedTargets({ manifest, hooks: ['swr', 'react-query'], zod: { mini: true }, models: true, socketHooks: true, keyPrefix: 'x' })).to.deep.equal(['swr', 'react-query', 'zod', 'models', 'socket-hooks']);
    expect(requestedTargets({ manifest, hooks: [], zod: false, models: false, socketHooks: false })).to.deep.equal([]);
  });

  it('names the server, next, mocks and msw targets, with next implying server', () => {
    expect(requestedTargets({ manifest, server: true, mocks: true, msw: true })).to.deep.equal(['server', 'mocks', 'msw']);
    expect(requestedTargets({ manifest, next: true })).to.deep.equal(['server', 'next']);
  });

  const rejections: [string, Partial<GenerateClientFilesOptions>, string][] = [
    ['an unknown hooks target, naming the allowed ones', { hooks: ['react-query', 'vue' as 'swr'] }, "generateClientFiles: unknown hooks target 'vue'; use react-query or swr"],
    ['a hooks target listed twice', { hooks: ['swr', 'react-query', 'swr'] }, "generateClientFiles: hooks target 'swr' is listed twice"],
    ['msw without mocks', { msw: true }, 'generateClientFiles: msw needs mocks, because the handlers are generated from the mocks'],
    ['socketHooks without hooks', { socketHooks: true }, 'generateClientFiles: socketHooks needs hooks, because socket hooks are added to the hooks files'],
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
