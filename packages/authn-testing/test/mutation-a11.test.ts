import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import 'mocha';
import { AUTHN_RULES, planCases, settleCase } from '../src/behaviour/index.js';
import type { HarnessContext, HarnessFactory, PlannedCase } from '../src/behaviour/index.js';
import { FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, fakeSeedPort } from '../src/fakes/index.js';
import type { SecretRow } from '../src/fakes/index.js';
import type { Harness } from '../src/harness/index.js';

const secretStoreHarness = (_ctx: HarnessContext, make: () => MemorySecretStore = () => new MemorySecretStore()): Harness => {
  const secrets = make();
  return { seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()), secrets, secretStorage: { rows: async () => secrets.rows() } };
};

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

const byName = (name: string): PlannedCase => {
  const hits = planCases(['A11']).filter((p) => p.kase.name === name);
  assert.strictEqual(hits.length, 1, `exactly one case named ${name}`);
  assert.ok(AUTHN_RULES.get('A11')!.cases.includes(hits[0].kase));
  return hits[0];
};

type Id = { type: string; id: string };

interface Flaws {
  keepsOlder?: boolean;
  reusable?: boolean;
  ignoresPurpose?: boolean;
  ignoresExpiry?: boolean;
  storesRaw?: boolean;
}

/** A secret store with one deliberate flaw per flag; flags off, it behaves like MemorySecretStore. */
class FlawedSecretStore extends MemorySecretStore {
  private readonly stored: (SecretRow & { raw: string })[] = [];

  constructor(private readonly flaws: Flaws) {
    super();
  }

  private same(r: SecretRow, id: Id, purpose: string) {
    return r.identity.type === id.type && r.identity.id === id.id && (this.flaws.ignoresPurpose || r.purpose === purpose);
  }

  async issue(identity: Id, purpose: string, ttlSeconds: number): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const now = Date.now();
    if (!this.flaws.keepsOlder) {
      const kept = this.stored.filter((r) => !(r.identity.type === identity.type && r.identity.id === identity.id && r.purpose === purpose));
      this.stored.splice(0, this.stored.length, ...kept);
    }
    this.stored.push({ identity, purpose, raw, hash: this.flaws.storesRaw ? raw : sha256hex(raw), createdAt: new Date(now), expiresAt: new Date(now + ttlSeconds * 1000), usedAt: null });
    return raw;
  }

  async redeem(identity: Id, purpose: string, raw: string): Promise<boolean> {
    const now = Date.now();
    const i = this.stored.findIndex((r) => r.raw === raw && this.same(r, identity, purpose) && (this.flaws.reusable || r.usedAt === null) && (this.flaws.ignoresExpiry || now < r.expiresAt.getTime()));
    if (i < 0) {
      return false;
    }
    this.stored[i] = { ...this.stored[i], usedAt: new Date(now) };
    return true;
  }

  rows(): readonly SecretRow[] {
    return this.stored.map(({ raw: _raw, ...row }) => row);
  }
}

const good: HarnessFactory = (ctx) => secretStoreHarness(ctx);
const flawed =
  (flaws: Flaws): HarnessFactory =>
  (ctx) =>
    secretStoreHarness(ctx, () => new FlawedSecretStore(flaws));

/** The case passes on the good store and fails on the mutant. */
async function bites(name: string, mutant: HarnessFactory): Promise<void> {
  const p = byName(name);
  const g = await settleCase(p, good);
  assert.strictEqual(g.status, 'passed', `${name} on MemorySecretStore: ${String(g.error)}`);
  const m = await settleCase(p, mutant);
  assert.strictEqual(m.status, 'failed', `${name} on the mutant`);
}

describe('mutation checks A11 (design §10.4)', function () {
  this.timeout(60_000);

  it('the flawless FlawedSecretStore passes the whole store facet', async () => {
    for (const p of planCases(['A11'], { facets: ['A11/store'] })) {
      const r = await settleCase(p, flawed({}));
      assert.strictEqual(r.status, 'passed', `${p.kase.name}: ${String(r.error)}`);
    }
  });

  it('M11a older secrets stay live', () => bites('A11 only the latest secret per purpose is live', flawed({ keepsOlder: true })));
  it('M11b no single use', () => bites('A11 a secret redeems once', flawed({ reusable: true })));
  it('M11c purpose ignored', () => bites('A11 a secret is bound to its purpose', flawed({ ignoresPurpose: true })));
  it('M11d expiry ignored', () => bites('A11 a secret expires', flawed({ ignoresExpiry: true })));
  it('M11e raw secret stored', () => bites('A11 only the SHA-256 of a secret is stored', flawed({ storesRaw: true })));
});
