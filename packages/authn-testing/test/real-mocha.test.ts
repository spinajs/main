import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import 'mocha';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsMocha = createRequire(import.meta.url).resolve('ts-mocha/bin/ts-mocha');

describe('real mocha', function () {
  this.timeout(180_000);

  it('runs a behaviour suite and the strategy conformance suite with mocha globals, skip and the pending summary', () => {
    const r = spawnSync(process.execPath, [tsMocha, '-p', 'tsconfig.json', '--config', 'test/real-mocha/mocharc.json', 'test/real-mocha/suite.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AUTHN_TESTING_SUMMARY: '' },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.strictEqual(r.status, 0, out);
    assert.match(out, /15 passing/, out);
    assert.match(out, /8 pending/, out);
    assert.match(out, /A07 a second login gets a new session id \[pending: missing http, http\.routes\.login, http\.routes\.whoami\]/, out);
    assert.match(out, /authn-testing pending: A07 a second login gets a new session id → http, http\.routes\.login, http\.routes\.whoami/, out);
    assert.match(out, /authn-testing pending: A07 the session cookie flags under production → config:env/, out);
    assert.match(out, /authn-testing pending: conformance: a non-interactive strategy returns account and account-ip keys from a stable id → n\/a for interactive strategies/, out);
  });
});
