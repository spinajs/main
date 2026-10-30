import 'mocha';
import { expect } from 'chai';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOT_TIMEOUT_MS = 30_000;

function listen(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`bundle did not start in ${BOOT_TIMEOUT_MS} ms:\n${out}`)), BOOT_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening (http:\/\/\S+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`bundle exited with ${code} before listening:\n${out}`));
    });
  });
}

describe('single-file bundle', function () {
  this.timeout(120_000);

  let work: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  before(() => {
    const built = spawnSync(process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs')], { cwd: PACKAGE, encoding: 'utf8' });
    expect(built.status, built.stderr || built.stdout).to.equal(0);
    // a copy outside the repository: no node_modules in any ancestor directory
    work = mkdtempSync(join(tmpdir(), 'spinajs-bundle-'));
    cpSync(join(PACKAGE, 'dist', 'bundle'), work, { recursive: true });
  });

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  after(() => rmSync(work, { recursive: true, force: true }));

  it('boots from the manifest in require mode from a directory with no node_modules at all and answers /health', async () => {
    expect(existsSync(join(work, 'node_modules')), 'the bundle ships no node_modules').to.equal(false);
    const started = Date.now();
    child = spawn(process.execPath, [join(work, 'main.mjs')], {
      cwd: work,
      env: { ...process.env, SPINAJS_MANIFEST_MODE: 'require', PORT: '0' },
    });
    const url = await listen(child);
    const bootMs = Date.now() - started;

    const res = await fetch(`${url}/health`);
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({ status: 'ok' });

    const sizeKb = Math.round(statSync(join(work, 'main.mjs')).size / 1024);
    console.log(`bundle: main.mjs ${sizeKb} KiB, ${readdirSync(work).length} entries, boot ${bootMs} ms`);
  });

  it('fails closed in require mode when the manifest is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'spinajs-bundle-empty-'));
    try {
      cpSync(join(work, 'main.mjs'), join(empty, 'main.mjs'));
      child = spawn(process.execPath, [join(empty, 'main.mjs')], { cwd: empty, env: { ...process.env, PORT: '0' } });
      await listen(child).then(
        () => expect.fail('the bundle booted without a manifest'),
        (err: Error) => expect(err.message).to.match(/ManifestMissing: system\.manifest\.mode is 'require' but .*app\.manifest\.json does not exist/),
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
