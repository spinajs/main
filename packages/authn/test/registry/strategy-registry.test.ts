import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { AuthenticationStrategy, StrategyRegistry, isCredentialSelector } from '../../src/index.js';
import type { Credentials, StrategyOutcome, ThrottleKey } from '../../src/index.js';
import { configuredChild, invalidOf, violationPaths } from '../behaviour/harness.js';

const expect = chai.expect;

abstract class TestStrategy extends AuthenticationStrategy {
  readonly interactive: boolean = false;
  throttleKeys(): readonly ThrottleKey[] {
    return [];
  }
  async verify(): Promise<StrategyOutcome> {
    return { ok: false, reason: 'invalid_credentials' };
  }
}

const token = (c: Credentials): string => {
  const t = (c as { token?: unknown }).token;
  return typeof t === 'string' ? t : '';
};

class LocalPassword extends TestStrategy {
  readonly name = 'local';
  readonly kinds = ['password'];
}

class PrefixBearer extends TestStrategy {
  readonly name = 'token';
  readonly kinds = ['bearer'];
  accepts(c: Credentials): boolean {
    return token(c).startsWith('spt_');
  }
}

class JwtBearer extends TestStrategy {
  readonly name = 'jwt';
  readonly kinds = ['bearer'];
  accepts(c: Credentials): boolean {
    return token(c).split('.').length === 3;
  }
}

class PlainBearer extends TestStrategy {
  readonly name = 'plain';
  readonly kinds = ['bearer'];
}

class ThrowingBearer extends TestStrategy {
  readonly name = 'throwing';
  readonly kinds = ['bearer'];
  accepts(): boolean {
    throw new Error('selector bug');
  }
}

class TruthyBearer extends TestStrategy {
  readonly name = 'truthy';
  readonly kinds = ['bearer'];
  accepts(): boolean {
    return 'yes' as unknown as boolean;
  }
}

class KeysMulti extends TestStrategy {
  readonly name = 'keys';
  readonly kinds = ['jws-assertion', 'http-signature'];
}

class KeysJws extends TestStrategy {
  readonly name = 'keys-jws';
  readonly kinds = ['jws-assertion'];
}

class NoKinds extends TestStrategy {
  readonly name = 'none';
  readonly kinds: readonly string[] = [];
}

class BadKinds extends TestStrategy {
  readonly name = 'bad-kinds';
  readonly kinds = 'password' as unknown as readonly string[];
}

class NonBooleanInteractive extends TestStrategy {
  readonly name = 'loose';
  readonly kinds = ['bearer'];
  readonly interactive = 'yes' as unknown as boolean;
}

class ChildOnly extends TestStrategy {
  readonly name = 'child';
  readonly kinds = ['password'];
}

class NotAStrategy {
  readonly name = 'stranger';
  readonly kinds = ['password'];
}

const ALL: Class<unknown>[] = [LocalPassword, PrefixBearer, JwtBearer, PlainBearer, ThrowingBearer, TruthyBearer, KeysMulti, KeysJws, NoKinds, BadKinds, NonBooleanInteractive];

class RegistryTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { authn: { strategies: [] } };
  }
}

class ChildTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { authn: { strategies: [{ name: 'child', service: 'ChildOnly' }] } };
  }
}

class ChildMixedConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      authn: {
        strategies: [
          { name: 'child', service: 'ChildOnly' },
          { name: 'local', service: 'LocalPassword' },
        ],
      },
    };
  }
}

const entry = (name: string, service: string) => ({ name, service });
const LOCAL = entry('local', 'LocalPassword');
const PLAIN = entry('plain', 'PlainBearer');
const TOKEN = entry('token', 'PrefixBearer');
const JWT = entry('jwt', 'JwtBearer');

const password: Credentials = { kind: 'password', login: 'alice', password: 'x' };
const bearer = (t: string): Credentials => ({ kind: 'bearer', token: t });

describe('StrategyRegistry', function () {
  this.timeout(15000);

  let cfg: Configuration;

  before(async () => {
    DI.register(RegistryTestConfiguration).as(Configuration);
    cfg = await DI.resolve(Configuration);
    expect(cfg).to.be.instanceOf(RegistryTestConfiguration);
    for (const t of ALL) DI.register(t).as(AuthenticationStrategy);
    DI.register(NotAStrategy).asSelf();
  });

  afterEach(() => {
    DI.uncache(StrategyRegistry);
    for (const t of ALL) DI.uncache(t);
  });

  after(() => {
    for (const t of [...ALL, NotAStrategy, RegistryTestConfiguration]) {
      DI.uncache(t);
      DI.unregister(t);
    }
  });

  async function boot(strategies: unknown): Promise<StrategyRegistry> {
    cfg.set('authn.strategies', strategies);
    return DI.resolve(StrategyRegistry);
  }

  async function bootFails(strategies: unknown, ...parts: string[]): Promise<string> {
    let error: unknown;
    try {
      await boot(strategies);
    } catch (e) {
      error = e;
    }
    expect(error, 'the boot fails').to.be.instanceOf(Error);
    for (const p of parts) expect((error as Error).message).to.contain(p);
    expect(DI.has(StrategyRegistry)).to.equal(false);
    return (error as Error).message;
  }

  const names = (r: StrategyRegistry): string[] => r.strategies().map((s) => s.name);

  describe('boot', () => {
    it('keeps the configured order', async () => {
      const r = await boot([TOKEN, LOCAL, entry('keys', 'KeysMulti')]);
      expect(names(r)).to.deep.equal(['token', 'local', 'keys']);
      expect(r.strategies()[0]).to.be.instanceOf(PrefixBearer);
      expect(r.strategies()[1]).to.be.instanceOf(LocalPassword);
      expect(Object.isFrozen(r.strategies())).to.equal(true);
    });

    it('resolves the strategies through DI as singletons', async () => {
      const r = await boot([LOCAL]);
      expect(r.strategies()[0]).to.equal(await DI.resolve(LocalPassword));
    });

    it('lists only the configured strategies', async () => {
      const r = await boot([LOCAL]);
      expect(names(r)).to.deep.equal(['local']);
    });

    it('boots with no strategies when authn.strategies is missing or empty', async () => {
      expect(names(await boot([]))).to.deep.equal([]);
    });

    it('fails on an unknown service name, naming the entry', async () => {
      await bootFails([LOCAL, entry('ghost', 'NoSuchStrategy')], '"ghost"', '"NoSuchStrategy"');
    });

    it('does not find a class that is not registered as an AuthenticationStrategy', async () => {
      await bootFails([entry('stranger', 'NotAStrategy')], '"NotAStrategy"');
    });

    it('fails when the configured name differs from the strategy name', async () => {
      await bootFails([entry('password', 'LocalPassword')], '"password"', '"local"');
    });

    it('fails on one service listed under two names', async () => {
      await bootFails([LOCAL, entry('local-2', 'LocalPassword')], '"local-2"');
    });

    it('fails on a strategy whose interactive is not a boolean', async () => {
      await bootFails([entry('loose', 'NonBooleanInteractive')], '"loose"', 'interactive');
    });

    it('fails on a strategy without kinds or with malformed kinds', async () => {
      await bootFails([entry('none', 'NoKinds')], '"none"');
      await bootFails([entry('bad-kinds', 'BadKinds')], '"bad-kinds"');
    });

    it('boots a strategy listed after one without accepts for the same kinds (D1: fall-through)', async () => {
      expect(names(await boot([PLAIN, TOKEN]))).to.deep.equal(['plain', 'token']);
      DI.uncache(StrategyRegistry);
      expect(names(await boot([entry('keys', 'KeysMulti'), entry('keys-jws', 'KeysJws')]))).to.deep.equal(['keys', 'keys-jws']);
    });

    it('boots when every listed strategy can run for some kind', async () => {
      expect(names(await boot([TOKEN, JWT, PLAIN]))).to.deep.equal(['token', 'jwt', 'plain']);
      DI.uncache(StrategyRegistry);
      expect(names(await boot([entry('keys-jws', 'KeysJws'), entry('keys', 'KeysMulti')]))).to.deep.equal(['keys-jws', 'keys']);
    });

    it('resolves a strategy registered as a named factory, and checks what it returns', async () => {
      const shared = new PlainBearer();
      const factories = { KitPlain: () => shared, KitBroken: () => ({ name: 'broken', kinds: ['bearer'] }) };
      DI.register(factories.KitPlain).as(AuthenticationStrategy);
      DI.register(factories.KitBroken).as(AuthenticationStrategy);
      try {
        const r = await boot([entry('plain', 'KitPlain')]);
        expect(r.strategies()[0]).to.equal(shared);
        DI.uncache(StrategyRegistry);
        await bootFails([entry('broken', 'KitBroken')], '"broken"', 'not an AuthenticationStrategy');
      } finally {
        // DI.unregister matches by type name, and every factory's type name is 'Function'.
        const list = DI.RootContainer.getRegisteredTypes(AuthenticationStrategy);
        for (const f of Object.values(factories)) list.splice(list.indexOf(f), 1);
      }
    });

    it('reads the list and the strategies of the container that resolves it', async () => {
      cfg.set('authn.strategies', [LOCAL]);
      const child = DI.RootContainer.child();
      child.register(ChildTestConfiguration).as(Configuration);
      child.register(ChildOnly).as(AuthenticationStrategy);
      try {
        await child.resolve(Configuration);
        const inChild = await child.resolve(StrategyRegistry);
        expect(names(inChild)).to.deep.equal(['child']);
        expect(inChild.candidates(password)[0]).to.be.instanceOf(ChildOnly);
        const inRoot = await DI.resolve(StrategyRegistry);
        expect(inRoot).to.not.equal(inChild);
        expect(names(inRoot)).to.deep.equal(['local']);
      } finally {
        await child.dispose();
      }
    });

    it('gives a child with its own Configuration its own registry after the root resolved one', async () => {
      cfg.set('authn.strategies', [LOCAL]);
      const inRoot = await DI.resolve(StrategyRegistry);
      const child = DI.RootContainer.child();
      child.register(ChildTestConfiguration).as(Configuration);
      child.register(ChildOnly).as(AuthenticationStrategy);
      try {
        await child.resolve(Configuration);
        const inChild = await child.resolve(StrategyRegistry);
        expect(inChild).to.not.equal(inRoot);
        expect(names(inChild)).to.deep.equal(['child']);
        expect(names(inRoot)).to.deep.equal(['local']);
      } finally {
        await child.dispose();
      }
    });

    it('lets a child list a root strategy next to one it registers itself', async () => {
      const child = DI.RootContainer.child();
      child.register(ChildMixedConfiguration).as(Configuration);
      child.register(ChildOnly).as(AuthenticationStrategy);
      try {
        await child.resolve(Configuration);
        const inChild = await child.resolve(StrategyRegistry);
        expect(names(inChild)).to.deep.equal(['child', 'local']);
        expect(inChild.strategies()[1]).to.be.instanceOf(LocalPassword);
      } finally {
        await child.dispose();
      }
    });

    it('throws when used before it is resolved', () => {
      const r = new StrategyRegistry(DI.RootContainer);
      expect(() => r.strategies()).to.throw(Error);
      expect(() => r.candidates(password)).to.throw(Error);
    });
  });


  describe('configuration shape', () => {
    const kids: IContainer[] = [];

    afterEach(async () => {
      for (const c of kids.splice(0)) await c.dispose();
    });

    async function bootChild(authn: unknown): Promise<StrategyRegistry> {
      const child = await configuredChild({ authn } as Record<string, unknown>);
      kids.push(child);
      return child.resolve(StrategyRegistry);
    }

    it('lists no strategy when authn.strategies is unset, through the schema default', async () => {
      expect(names(await bootChild({}))).to.deep.equal([]);
    });

    const refused: [string, unknown, string][] = [
      ['a string instead of a list', 'LocalPassword', 'authn.strategies'],
      ['an entry without a service', [{ name: 'local' }], 'authn.strategies.0.service'],
      ['an entry with an empty name', [{ name: '', service: 'LocalPassword' }], 'authn.strategies.0.name'],
      ['a null entry', [null], 'authn.strategies.0'],
      ['the same name with two services', [LOCAL, entry('local', 'PlainBearer')], 'authn.strategies'],
      // Config files concatenate arrays; the schema keeps one entry per name, identical repeats included.
      ['an identical entry listed twice', [LOCAL, { ...LOCAL }], 'authn.strategies'],
    ];
    for (const [what, strategies, path] of refused) {
      it(`refuses ${what}, naming ${path}`, async () => {
        expect(await violationPaths(configuredChild({ authn: { strategies } }))).to.include(path);
      });
    }

    it('does not echo config values of a malformed entry', async () => {
      const error = await invalidOf(configuredChild({ authn: { strategies: [LOCAL, { name: 'oops', options: { secret: 'hunter2-secret' } }] } }));
      expect(error.message).to.not.contain('hunter2');
      expect(error.violations.map((v) => v.path)).to.include('authn.strategies.1.service');
    });
  });

  describe('candidates', () => {
    const cand = (r: StrategyRegistry, c: Credentials): string[] => r.candidates(c).map((s) => s.name);

    it('lists the listed strategies for the credential kind, in list order', async () => {
      const r = await boot([LOCAL, PLAIN, entry('keys', 'KeysMulti'), entry('keys-jws', 'KeysJws')]);
      expect(cand(r, password)).to.deep.equal(['local']);
      expect(cand(r, bearer('abc'))).to.deep.equal(['plain']);
      expect(cand(r, { kind: 'jws-assertion', jws: 'x' })).to.deep.equal(['keys', 'keys-jws']);
      expect(Object.isFrozen(r.candidates(password))).to.equal(true);
    });

    it('is empty when no listed strategy takes the kind', async () => {
      const r = await boot([LOCAL]);
      expect(cand(r, bearer('abc'))).to.deep.equal([]);
      expect(cand(r, { kind: 'kit-unknown' })).to.deep.equal([]);
    });

    it('never lists a registered strategy that is not listed', async () => {
      const r = await boot([LOCAL]);
      expect(cand(r, bearer('spt_x'))).to.deep.equal([]);
    });

    it('leaves out a strategy whose accepts declines and keeps those without accepts', async () => {
      const r = await boot([TOKEN, JWT, PLAIN]);
      expect(cand(r, bearer('spt_abc'))).to.deep.equal(['token', 'plain']);
      expect(cand(r, bearer('a.b.c'))).to.deep.equal(['jwt', 'plain']);
      expect(cand(r, bearer('opaque'))).to.deep.equal(['plain']);
    });

    it('keeps the list order when a strategy without accepts comes first', async () => {
      const r = await boot([PLAIN, TOKEN]);
      expect(cand(r, bearer('spt_abc'))).to.deep.equal(['plain', 'token']);
    });

    it('is empty when every candidate declines', async () => {
      const r = await boot([TOKEN, JWT]);
      expect(cand(r, bearer('opaque'))).to.deep.equal([]);
    });

    it('treats a throwing or non-boolean accepts as a decline', async () => {
      const r = await boot([entry('throwing', 'ThrowingBearer'), entry('truthy', 'TruthyBearer'), PLAIN]);
      expect(cand(r, bearer('x'))).to.deep.equal(['plain']);
    });

    it('is empty for malformed credentials', async () => {
      const r = await boot([LOCAL, PLAIN]);
      expect(cand(r, null as unknown as Credentials)).to.deep.equal([]);
      expect(cand(r, {} as unknown as Credentials)).to.deep.equal([]);
      expect(cand(r, { kind: 1 } as unknown as Credentials)).to.deep.equal([]);
    });
  });

  describe('isCredentialSelector', () => {
    it('is true only for objects with an accepts function', () => {
      expect(isCredentialSelector(new PrefixBearer())).to.equal(true);
      expect(isCredentialSelector(new LocalPassword())).to.equal(false);
      expect(isCredentialSelector({ accepts: true })).to.equal(false);
      expect(isCredentialSelector(null)).to.equal(false);
      expect(isCredentialSelector(undefined)).to.equal(false);
    });
  });
});
