import 'mocha';
import { expect } from 'chai';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));

async function inputsOf(entry: string): Promise<{ inputs: string[]; imports: unknown[] }> {
  const result = await build({ absWorkingDir: packageDir, entryPoints: [entry], bundle: true, minify: true, write: false, metafile: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return { inputs: Object.keys(result.metafile.inputs), imports: Object.values(result.metafile.outputs).flatMap((o) => o.imports) };
}

describe('@spinajs/client/mocks: packaging', function () {
  // A cold esbuild start takes several seconds on a loaded machine, beyond mocha's default under --no-config.
  this.timeout(30000);

  it('bundles from its own files and @spinajs/client/formats only', async () => {
    const { inputs, imports } = await inputsOf('src/mocks/index.ts');
    expect(inputs.filter((path) => !path.startsWith('src/mocks/') && !path.startsWith('src/formats/'))).to.deep.equal([]);
    expect(imports).to.deep.equal([]);
  });

  it('is not part of the runtime or formats bundles', async () => {
    for (const entry of ['src/runtime/index.ts', 'src/formats/index.ts']) {
      expect((await inputsOf(entry)).inputs.filter((path) => path.startsWith('src/mocks/')), entry).to.deep.equal([]);
    }
  });

  it('is exported as @spinajs/client/mocks', async () => {
    const mocks = (await import('@spinajs/client/mocks')) as Record<string, unknown>;
    for (const name of ['mockFrom', 'mockPage', 'mockCursorPage', 'createMockClient', 'MockNotImplemented', 'MockUnsupported', 'Rng']) expect(mocks[name], name).to.be.a('function');
  });
});
