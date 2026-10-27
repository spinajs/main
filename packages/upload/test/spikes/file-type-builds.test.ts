import 'mocha';
import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Runs inside an async function that has FileTypeParser in scope.
const PROBE = `
  const parser = new FileTypeParser({ customDetectors: [{ id: 'spike', detect: async () => ({ ext: 'spk', mime: 'application/x-spike' }) }] });
  const custom = await parser.fromBuffer(new Uint8Array([1, 2, 3]));
  const pdf = await new FileTypeParser().fromBuffer(new TextEncoder().encode('%PDF-1.7\\n'));
  process.stdout.write(JSON.stringify({ custom, pdf }));
`;

const EXPECTED = { custom: { ext: 'spk', mime: 'application/x-spike' }, pdf: { ext: 'pdf', mime: 'application/pdf' } };

function probe(args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, args, { cwd: PKG, encoding: 'utf8' })) as unknown;
}

describe('spike §11.5: file-type through loadFileType()', function () {
  this.timeout(30000);

  it('works from lib/, with a real dynamic import', () => {
    const entry = join(PKG, 'lib', 'file-type.js');
    expect(existsSync(entry), `${entry} missing: build upload first`).to.eq(true);
    const url = pathToFileURL(entry).href;
    const out = probe(['--input-type=module', '-e', `const { loadFileType } = await import(${JSON.stringify(url)}); const { FileTypeParser } = await loadFileType(); ${PROBE}`]);
    expect(out).to.deep.equal(EXPECTED);
  });
});
