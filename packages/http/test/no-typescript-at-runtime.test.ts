import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ProbeImport {
  specifier: string;
  parent: string;
}

interface ProbeResult {
  unsupported?: string;
  body?: unknown;
  error?: { name: string; message: string };
  imports: ProbeImport[];
}

const HTTP_LIB = `${resolve(process.cwd(), 'lib')}${sep}`;

const fromHttp = (i: ProbeImport): boolean => i.parent.startsWith('file:') && fileURLToPath(i.parent).startsWith(HTTP_LIB);

const isTypescript = (i: ProbeImport): boolean => i.specifier === 'typescript' || i.specifier.startsWith('typescript/');

/** Out of process and on the built packages: ts-node, which runs this suite, loads typescript itself. */
function probe(...options: string[]): ProbeResult {
  const args = [resolve(process.cwd(), 'test', 'support', 'no-typescript', 'probe.mjs'), ...options];
  const run = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', timeout: 110000 });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(match[1]) as ProbeResult;
  if (result.unsupported) throw new Error(result.unsupported);
  return result;
}

describe('typescript at runtime', function () {
  this.timeout(120000);

  describe('in require mode', () => {
    let result: ProbeResult;

    before(() => {
      result = probe();
    });

    it('serves a manifest-listed controller with arguments bound by the manifest names', () => {
      expect(result.error).to.equal(undefined);
      expect(result.body).to.deep.equal({ value: 'ok' });
    });

    // glob is only checked for http: `@spinajs/configuration` still imports it
    it('http imports neither typescript nor glob', () => {
      expect(result.imports.filter(fromHttp)).to.deep.equal([]);
    });

    it('nothing imports typescript', () => {
      expect(result.imports.filter(isTypescript)).to.deep.equal([]);
    });
  });

  describe('in off mode without typescript', () => {
    let cache: string;

    beforeEach(() => {
      cache = mkdtempSync(join(tmpdir(), 'spinajs-probe-controller-cache-'));
    });

    afterEach(() => {
      rmSync(cache, { recursive: true, force: true });
    });

    it('fails a cache miss naming the optional peer and the alternatives, importing typescript only from the cache', () => {
      const result = probe('off', cache, 'no-typescript');

      expect(result.error?.name).to.equal('NoControllerMetadata');
      expect(result.error?.message).to.include('optional peer dependency `typescript`');
      expect(result.error?.message).to.include('spinajs http:controllers:cache');
      expect(result.error?.message).to.include('spinajs build');
      expect(result.imports.filter(isTypescript).map((i) => fileURLToPath(i.parent).slice(HTTP_LIB.length))).to.deep.equal(['cache.js']);
    });

    it('boots from a pre-built controller cache without importing typescript', () => {
      expect(probe('off', cache).body, 'the run that fills the cache').to.deep.equal({ value: 'ok' });

      const result = probe('off', cache, 'no-typescript');

      expect(result.error).to.equal(undefined);
      expect(result.body).to.deep.equal({ value: 'ok' });
      expect(result.imports.filter(isTypescript)).to.deep.equal([]);
    });
  });
});
