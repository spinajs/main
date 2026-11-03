import 'mocha';
import { expect } from 'chai';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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

async function cacheEntries(dir: string): Promise<number> {
  const count = () => (existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0);
  for (let waited = 0; waited < 5000 && count() <= 1; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  return count();
}

describe('the esbuild bundle', function () {
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
    const tmp = join(work, 'tmp');
    const cacheRoot = join(work, 'cache');
    mkdirSync(tmp);
    // the per-user cache root: XDG_CACHE_HOME on POSIX, LOCALAPPDATA on Windows
    const env: NodeJS.ProcessEnv = { ...process.env, SPINAJS_MANIFEST_MODE: 'require', PORT: '0', TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cacheRoot, LOCALAPPDATA: cacheRoot };
    delete env.NODE_COMPILE_CACHE;
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const started = Date.now();
    child = spawn(process.execPath, [join(work, 'main.mjs')], { cwd: work, env });
    const url = await listen(child);
    const bootMs = Date.now() - started;
    // written once the app listens, so a server stopped by a signal still leaves it for the next start
    expect(await cacheEntries(join(cacheRoot, 'spinajs', 'compile-cache')), 'compile cache entries').to.be.greaterThan(1);
    expect(readdirSync(tmp), 'the shared temp dir').to.deep.equal([]);

    const res = await fetch(`${url}/health`);
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({ status: 'ok' });

    const sizeKb = Math.round(statSync(join(work, 'app.mjs')).size / 1024);
    console.log(`bundle: app.mjs ${sizeKb} KiB, ${readdirSync(work).length} entries, boot ${bootMs} ms`);
  });

  it('fails closed in require mode when the manifest is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'spinajs-bundle-empty-'));
    try {
      for (const file of ['main.mjs', 'app.mjs']) cpSync(join(work, file), join(empty, file));
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
