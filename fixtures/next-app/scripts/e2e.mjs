// Generates the client, boots app-basic, builds and starts this app, and checks Next's cache through the generated client.next.ts.
// Needs the repository built first (`npm ci && npm run build` at the root), and `npm ci` here.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const client = fileURLToPath(new URL('../../../packages/client/', import.meta.url));
const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));
const children = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: app, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${args.join(' ')} exited with ${result.status}`);
}

function start(args, options) {
  // Its own process group outside Windows, so stopAll reaches any process it starts.
  const detached = process.platform !== 'win32';
  const child = spawn(process.execPath, args, { ...options, detached, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return child;
}

// The API server prints one JSON line with its URLs once it listens.
function startApi(frontendOrigin) {
  const child = start(['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', '--no-warnings', 'test/support/next-fixture-api.ts'], {
    cwd: client,
    env: { TS_NODE_PROJECT: 'tsconfig.json', FRONTEND_ORIGIN: frontendOrigin },
  });
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`the app-basic server exited with ${code}`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith('{')) resolve(JSON.parse(line));
      else console.log(`[api] ${line}`);
    });
  });
}

async function waitFor(url, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // `next start` may run the server in a child process of its own.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  }
}

async function main() {
  const nextPort = await freePort();
  const origin = `http://127.0.0.1:${nextPort}`;
  run(['scripts/generate.mjs']);
  const api = await startApi(origin);
  const env = { SPINAJS_API_URL: api.api, NEXT_TELEMETRY_DISABLED: '1' };
  run([nextBin, 'build', '--webpack'], env);
  const next = start([nextBin, 'start', '-H', '127.0.0.1', '-p', String(nextPort)], { cwd: app, env });
  next.stdout.on('data', (chunk) => process.stdout.write(`[next] ${chunk}`));
  await waitFor(origin);

  const counts = async () => {
    const all = await (await fetch(api.counter)).json();
    console.log(`  requests seen by the API: ${JSON.stringify(all)}`);
    return all['GET /users/list'] ?? 0;
  };
  const page = async (headers = {}) => {
    const response = await fetch(`${origin}/users`, { headers });
    assert.equal(response.status, 200);
    return response.text();
  };
  const check = (name, fn) => fn().then(() => console.log(`ok - ${name}`));

  await check('the page renders the fixture user, fetched on the server', async () => {
    assert.match(await page(), /ada@example\.com/);
    assert.equal(await counts(), 1);
  });

  await check("a second render is served from Next's cache", async () => {
    assert.match(await page(), /ada@example\.com/);
    assert.equal(await counts(), 1);
  });

  await check('a request with a cookie is never served from or stored in the cache', async () => {
    await page({ cookie: 'session=e2e' });
    await page({ cookie: 'session=e2e' });
    assert.equal(await counts(), 3);
    await page();
    assert.equal(await counts(), 3);
  });

  await check('the server action creates a user through the CSRF guard and revalidates the users tag', async () => {
    const html = await page();
    const actionField = /name="(\$ACTION_ID_[0-9a-f]+)"/.exec(html)?.[1];
    assert.ok(actionField, 'the form carries the server action id');
    const form = new FormData();
    form.set(actionField, '');
    form.set('email', 'grace@example.com');
    const response = await fetch(`${origin}/users`, { method: 'POST', body: form, headers: { origin, cookie: 'session=e2e' }, redirect: 'manual' });
    assert.ok(response.status < 400, `the action answered ${response.status}`);
    const before = await counts();
    // 'max' is stale-while-revalidate: the first render may still show the cached list while it refetches.
    let html2 = '';
    for (let i = 0; i < 20 && !html2.includes('grace@example.com'); i++) {
      html2 = await page();
      if (!html2.includes('grace@example.com')) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.match(html2, /grace@example\.com/);
    assert.equal(await counts(), before + 1);
    await page();
    assert.equal(await counts(), before + 1);
  });
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  stopAll();
}
if (failure) console.error(failure);
process.exit(failure ? 1 : 0);
