import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { AuthzConfigError, GLOBAL, ResourceAdapter, UnknownPermission } from '../../src/index.js';
import type { PermissionDef, ResourceRef, ResourceType } from '../../src/index.js';
import { FakeAdapter, FakeRow, FakeScopeResolver, RecordingLog, StaticModel, fakeClock, permit, principal, registryOf } from './fakes.js';
import type { FakeAdapterOptions } from './fakes.js';

const expect = chai.expect;

const alice = principal('user', 'alice');
const bob = principal('user', 'bob');
const LATE = /^Authz domain "root": resource type "invoice" was registered with adapter "orm" after the domain booted; register it before boot, or boot the domain again$/;

/** Like authz-orm's adapter: `types` and `permissions()` are live views of a registry that grows after the Authorizer is built. */
class LiveAdapter extends FakeAdapter {
  private readonly defs: Omit<PermissionDef, 'source'>[] = [];

  constructor(private readonly live: ResourceType[], options: FakeAdapterOptions = {}) {
    super(live, { kind: 'orm', ...options });
  }

  register(type: ResourceType): void {
    this.live.push(type);
    this.defs.push({ name: `${type}:read`, resource: type, action: 'read', types: [type] });
  }

  permissions(): readonly Omit<PermissionDef, 'source'>[] {
    return this.defs;
  }
}

/** Reads fine while the Authorizer indexes it, then throws (or answers junk) from `types` and `permissions()`. */
class BrokenAdapter extends ResourceAdapter {
  readonly kind = 'broken';
  mode: 'ok' | 'throw' | 'junk' = 'ok';

  get types(): readonly ResourceType[] {
    if (this.mode === 'throw') throw new Error('types down');
    return (this.mode === 'junk' ? 42 : ['file']) as readonly ResourceType[];
  }

  accepts(_target: unknown): _target is never {
    return false;
  }

  refOf(): ResourceRef {
    throw new Error('never');
  }

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref, GLOBAL];
  }

  permissions(): readonly Omit<PermissionDef, 'source'>[] {
    if (this.mode === 'throw') throw new Error('permissions down');
    return (this.mode === 'junk' ? [null, { name: 'invoice:read', types: 7 }] : []) as unknown as readonly Omit<PermissionDef, 'source'>[];
  }
}

const KNOWN = [
  { name: 'doc:read', types: ['doc'] },
  { name: 'org:view', types: ['org'] },
  { name: 'misc:read', types: ['misc'] },
];

const make = (options: Partial<AuthorizerOptions>): Authorizer => new Authorizer({ domain: 'root', models: [new StaticModel('rbac', { vote: permit() })], registry: registryOf(KNOWN), clock: fakeClock().clock, log: new RecordingLog(), ...options });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function expectLate(e: unknown, permissionLookup = false): void {
  expect(e).to.be.instanceOf(AuthzConfigError);
  expect((e as Error).message).to.match(LATE);
  if (permissionLookup) expect(e).to.be.instanceOf(UnknownPermission);
}

describe('Authorizer: a resource type registered after the Authorizer was built', () => {
  const invoice: ResourceRef = { type: 'invoice' };
  const row = new FakeRow('invoice', 'i1');

  describe('its permission is not in the registry (only the adapter lists it now)', () => {
    const setup = () => {
      const adapter = new LiveAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
      const a = make({ adapters: [adapter] });
      adapter.register('invoice');
      adapter.add(row);
      return a;
    };

    it('check, explain and a check on a row of the late type throw the late-type error as an UnknownPermission', async () => {
      const a = setup();
      expectLate(await rejection(a.check({ principal: alice, permission: 'invoice:read', resource: invoice })), true);
      expectLate(await rejection(a.check({ principal: alice, permission: 'invoice:read' })), true);
      expectLate(await rejection(a.explain({ principal: alice, permission: 'invoice:read', resource: invoice })), true);
      expectLate(await rejection(a.check({ principal: alice, permission: 'invoice:read', resource: row })), true);
    });

    it('checkMany, filter and filterNow throw it too', async () => {
      const a = setup();
      expectLate(await rejection(a.checkMany(alice, ['invoice:read'])), true);
      expectLate(await rejection(a.checkMany(alice, ['invoice:read'], row)), true);
      expectLate(await rejection(a.filter(alice, 'invoice:read', 'invoice')), true);
      expectLate(
        thrown(() => a.filterNow(alice, 'invoice:read', 'invoice')),
        true,
      );
    });

    it('a permission no late adapter lists stays the plain UnknownPermission', async () => {
      const a = setup();
      const e = await rejection(a.check({ principal: alice, permission: 'nope:read', resource: invoice }));
      expect(e).to.be.instanceOf(UnknownPermission);
      expect((e as Error).message).to.equal('Unknown permission "nope:read"');
    });
  });

  describe('its permission is already in the registry (config or another source)', () => {
    const setup = () => {
      const adapter = new LiveAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
      const a = make({ adapters: [adapter], registry: registryOf([...KNOWN, { name: 'invoice:read', types: ['invoice'] }]) });
      adapter.register('invoice');
      adapter.add(row);
      return { a, adapter };
    };

    it('check, explain and a check on a row throw instead of deciding without the adapter', async () => {
      const { a, adapter } = setup();
      expectLate(await rejection(a.check({ principal: alice, permission: 'invoice:read', resource: invoice })));
      expectLate(await rejection(a.check({ principal: alice, permission: 'invoice:read', resource: { type: 'invoice', id: 'i1' } })));
      expectLate(await rejection(a.explain({ principal: alice, permission: 'invoice:read', resource: invoice })));
      expectLate(await rejection(a.check({ principal: alice, permission: 'invoice:read', resource: row })));
      expect(adapter.ancestorCalls, 'no ancestors are read for the late type').to.deep.equal([]);
    });

    it('checkMany, filter and filterNow throw it too', async () => {
      const { a } = setup();
      expectLate(await rejection(a.checkMany(alice, ['invoice:read'], invoice)));
      expectLate(await rejection(a.checkMany(alice, ['invoice:read'], row)));
      expectLate(await rejection(a.filter(alice, 'invoice:read', 'invoice')));
      expectLate(thrown(() => a.filterNow(alice, 'invoice:read', 'invoice')));
    });

    it('summary and covers at a ref of the late type throw instead of answering with no permissions', async () => {
      const { a } = setup();
      for (const at of [invoice, { type: 'invoice', id: 'i1' }]) {
        expectLate(await rejection(a.summary(alice, at)));
        expectLate(await rejection(a.covers(alice, bob, at)));
      }
    });

    it('checks, summary and covers of known types and at $global still answer', async () => {
      const { a } = setup();
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } })).allowed).to.equal(true);
      expect(a.filterNow(alice, 'doc:read', 'doc')).to.deep.equal({ op: 'true' });
      expect((await a.summary(alice, { type: 'doc' })).permissions.map((p) => p.name)).to.deep.equal(['doc:read']);
      expect((await a.summary(alice)).permissions.map((p) => p.name)).to.include('invoice:read');
      expect(await a.covers(alice, bob, { type: 'doc' })).to.equal(false);
    });
  });

  describe('adapters whose live view cannot be read, and types no adapter took', () => {
    it('a throwing or junk types/permissions on an unrelated adapter breaks neither known checks nor the late-type error', async () => {
      for (const mode of ['throw', 'junk'] as const) {
        const broken = new BrokenAdapter();
        const adapter = new LiveAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
        const a = make({ adapters: [broken, adapter] });
        broken.mode = mode;
        adapter.register('invoice');
        expect((await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } })).allowed, mode).to.equal(true);
        expect((await a.check({ principal: alice, permission: 'misc:read', resource: { type: 'misc' } })).allowed, mode).to.equal(true);
        expectLate(await rejection(a.check({ principal: alice, permission: 'invoice:read', resource: invoice })), true);
        const e = await rejection(a.check({ principal: alice, permission: 'nope:read' }));
        expect((e as Error).message, mode).to.equal('Unknown permission "nope:read"');
      }
    });

    it('a resolver-only type and a type no adapter handles behave as before', async () => {
      const adapter = new LiveAdapter(['doc']);
      const a = make({ adapters: [adapter], scopeResolvers: [new FakeScopeResolver(['org'], { 'org:o1': null })] });
      adapter.register('invoice');
      expect((await a.check({ principal: alice, permission: 'org:view', resource: { type: 'org', id: 'o1' } })).allowed).to.equal(true);
      expect((await a.check({ principal: alice, permission: 'misc:read', resource: { type: 'misc', id: 'm1' } })).allowed).to.equal(true);
      expect((await a.summary(alice, { type: 'org', id: 'o1' })).permissions.map((p) => p.name)).to.deep.equal(['org:view']);
      const e = await rejection(a.check({ principal: alice, permission: 'doc:read', resource: { type: 'misc' } }));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.include('which is not in its types');
    });
  });

  describe('a model that reads a node of the late type through ctx', () => {
    const node: ResourceRef = { type: 'invoice', id: 'i1' };
    const reading = (read: 'ancestors' | 'attributes') =>
      new StaticModel('rbac', {
        vote: async (_req, ctx) => {
          const answer = read === 'ancestors' ? await ctx.ancestors(node) : await ctx.attributes(node);
          return { model: 'rbac', permitWhen: answer === null ? { op: 'false' } : { op: 'true' }, denyWhen: { op: 'false' }, cacheable: true };
        },
      });

    for (const read of ['ancestors', 'attributes'] as const) {
      it(`ctx.${read} of a late-type node makes the model indeterminate instead of answering as for a type without adapter`, async () => {
        const log = new RecordingLog();
        const adapter = new LiveAdapter(['doc'], { rows: [new FakeRow('doc', 'd1')] });
        const a = make({ adapters: [adapter], models: [reading(read)], log });
        adapter.register('invoice');
        adapter.add(row);
        const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
        expect(d.allowed).to.equal(false);
        expect(d.reason?.code).to.equal('model_error');
        expect(
          log.entries.some((e) => `${e.message} ${e.args.map(String).join(' ')}`.includes('was registered with adapter "orm" after the domain booted')),
          JSON.stringify(log.entries),
        ).to.equal(true);
      });
    }
  });
});
