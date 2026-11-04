import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { generateClient, generateClientFiles, type GenerateClientFilesOptions } from '../src/index.js';
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
    const [file] = await generateClientFiles({ manifest, models: false, socketHooks: false, keyPrefix: 'app', zod: false, hooks: [] });
    expect(file.contents).to.equal(client);
  });

  for (const companion of [{ zod: true }, { zod: { mini: true } }, { hooks: ['react-query'] }, { hooks: ['swr'] }] as Partial<GenerateClientFilesOptions>[]) {
    it(`exports manifestHash from client.ts when a companion is requested (${JSON.stringify(companion)})`, async () => {
      const [file] = await generateClientFiles({ manifest, ...companion });
      expect(file.path).to.equal('client.ts');
      const hashLine = `export const manifestHash = '${manifest.hash}';\n\n`;
      expect(file.contents).to.include(hashLine);
      expect(file.contents.replace(hashLine, '')).to.equal(client);
      expect(typecheck(file.contents)).to.deep.equal([]);
    });
  }

  it('rejects an unknown hooks target, naming the allowed ones', async () => {
    const error = await generateClientFiles({ manifest, hooks: ['react-query', 'vue' as 'swr'] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal("generateClientFiles: unknown hooks target 'vue'; use react-query or swr");
  });
});
