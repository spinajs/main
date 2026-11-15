import 'mocha';
import { expect } from 'chai';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));

describe('@spinajs/client/formats: packaging', function () {
  // A cold esbuild start takes several seconds on a loaded machine, beyond mocha's default under --no-config.
  this.timeout(30000);

  it('bundles from its own files only', async () => {
    const result = await build({
      absWorkingDir: packageDir,
      entryPoints: ['src/formats/index.ts'],
      bundle: true,
      minify: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((path) => !path.startsWith('src/formats/'))).to.deep.equal([]);
    for (const output of Object.values(result.metafile.outputs)) {
      expect(output.imports).to.deep.equal([]);
    }
  });

  it('is exported as @spinajs/client/formats', async () => {
    const formats = (await import('@spinajs/client/formats')) as Record<string, unknown>;
    expect(formats.isEmail).to.be.a('function');
    expect(formats.formatPredicate).to.be.a('function');
  });
});
