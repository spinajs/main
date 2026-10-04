import 'mocha';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import authnTotpConfig from '../../src/config/authn-totp.js';

type Tree = Record<string, unknown>;
type Check = (config: { get<T>(path: string | string[]): T }, log: { warn(message: string): void }) => readonly unknown[];

// authn's root entry registers DefaultAuthnService as a side effect, which the CLI test relies on being absent, and
// its exports map hides the config file; both load from lib, as the config loader does.
const authnLib = (file: string) => pathToFileURL(resolve(process.cwd(), '../authn/lib/mjs', file)).href;

let checkAuthnLegacyKeys: Check;
before(async () => {
  checkAuthnLegacyKeys = ((await import(authnLib('service/boot/legacy-keys.js'))) as { checkAuthnLegacyKeys: Check }).checkAuthnLegacyKeys;
});

const isTree = (v: unknown): v is Tree => v !== null && typeof v === 'object' && !Array.isArray(v);

// The config loader concatenates arrays and merges objects across package files.
function merge(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isTree(prev) && isTree(v) ? merge(prev, v) : Array.isArray(prev) && Array.isArray(v) ? [...prev, ...v] : v;
  }
  return out;
}

function source(tree: Tree) {
  return {
    get<T>(path: string | string[]): T {
      const parts = Array.isArray(path) ? path : path.split('.');
      return parts.reduce<unknown>((node, key) => (isTree(node) ? node[key] : undefined), tree) as T;
    },
  };
}

describe('v3 config: no 2.x keys shipped', () => {
  it('ships no rbac.* key', () => {
    assert.strictEqual((authnTotpConfig as unknown as Tree).rbac, undefined);
  });

  it('a boot with authn.config.rejectLegacyKeys true passes on the shipped authn and authn-totp configs', async () => {
    const authnConfig = ((await import(authnLib('config/authn.js'))) as { default: Tree }).default;
    const merged = merge(merge(authnConfig, authnTotpConfig as unknown as Tree), { authn: { config: { rejectLegacyKeys: true } } });
    const warnings: string[] = [];
    assert.deepStrictEqual(checkAuthnLegacyKeys(source(merged), { warn: (m) => warnings.push(m) }), []);
    assert.deepStrictEqual(warnings, []);
  });

  it('the same check refuses the 2.x rbac.twoFactorAuth block this package used to ship', () => {
    const legacy = { authn: { config: { rejectLegacyKeys: true } }, rbac: { twoFactorAuth: { enabled: true, forceUser: false, service: 'Default2FaToken' } } };
    assert.throws(() => checkAuthnLegacyKeys(source(legacy), { warn: () => undefined }), /rbac\.twoFactorAuth\.enabled/);
  });
});
