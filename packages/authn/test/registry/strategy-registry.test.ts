import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { AuthenticationStrategy, StrategyRegistry, isCredentialSelector } from '../../src/index.js';
import type { Credentials, StrategyOutcome, ThrottleKey } from '../../src/index.js';

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
      expect(names(await boot(undefined))).to.deep.equal([]);
      DI.uncache(StrategyRegistry);
      expect(names(await boot([]))).to.deep.equal([]);
    });

    it('fails on an unknown service name, naming the entry', async () => {
      await bootFails([LOCAL, entry('ghost', 'NoSuchStrategy')], '"ghost"', '"NoSuchStrategy"');
    });

    it('does not find a class that is not registered as an AuthenticationStrategy', async () => {
      await bootFails([entry('stranger', 'NotAStrategy')], '"NotAStrategy"');
    });

    it('fails on the same name listed with two services', async () => {
      await bootFails([LOCAL, entry('local', 'PlainBearer')], 'duplicate', '"local"');
    });

    it('collapses identical entries that config files repeat (arrays merge by concat)', async () => {
      cfg.set('authn.strategies', [LOCAL, TOKEN]);
      cfg.merge('authn', { strategies: [LOCAL] });
      expect(cfg.get('authn.strategies')).to.have.length(3);
      const r = await DI.resolve(StrategyRegistry);
      expect(names(r)).to.deep.equal(['local', 'token']);
    });

    it('fails when the configured name differs from the strategy name', async () => {
      await bootFails([entry('password', 'LocalPassword')], '"password"', '"local"');
    });

    it('fails on one service listed under two names', async () => {
      await bootFails([LOCAL, entry('local-2', 'LocalPassword')], '"local-2"');
    });

    it('fails on malformed entries', async () => {
      await bootFails('LocalPassword', 'authn.strategies');
      await bootFails([{ name: 'local' }], 'authn.strategies');
      await bootFails([{ name: '', service: 'LocalPassword' }], 'authn.strategies');
      await bootFails([null], 'authn.strategies');
    });

    it('does not echo config values of malformed entries', async () => {
      expect(await bootFails('hunter2-secret', 'authn.strategies')).to.not.contain('hunter2');
      const message = await bootFails([LOCAL, { name: 'oops', options: { secret: 'hunter2-secret' } }], 'authn.strategies[1]', 'service');
      expect(message).to.not.contain('hunter2');
    });

    it('fails on a strategy whose interactive is not a boolean', async () => {
      await bootFails([entry('loose', 'NonBooleanInteractive')], '"loose"', 'interactive');
    });

    it('fails on a strategy without kinds or with malformed kinds', async () => {
      await bootFails([entry('none', 'NoKinds')], '"none"');
      await bootFails([entry('bad-kinds', 'BadKinds')], '"bad-kinds"');
    });

    it('fails on a strategy an earlier one without accepts always shadows', async () => {
      await bootFails([PLAIN, TOKEN], '"token"', '"plain"');
      await bootFails([entry('keys', 'KeysMulti'), entry('keys-jws', 'KeysJws')], '"keys-jws"', '"keys"');
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
        expect(inChild.select(password)).to.be.instanceOf(ChildOnly);
        const inRoot = await DI.resolve(StrategyRegistry);
        expect(inRoot).to.not.equal(inChild);
        expect(names(inRoot)).to.deep.equal(['local']);
      } finally {
        await child.dispose();
      }
    });

    it('throws when used before it is resolved', () => {
      const r = new StrategyRegistry(DI.RootContainer);
      expect(() => r.strategies()).to.throw(Error);
      expect(() => r.select(password)).to.throw(Error);
    });
  });

  describe('select', () => {
    it('picks the listed strategy for the credential kind', async () => {
      const r = await boot([LOCAL, PLAIN]);
      expect(r.select(password)?.name).to.equal('local');
      expect(r.select(bearer('abc'))?.name).to.equal('plain');
    });

    it('returns undefined when no listed strategy takes the kind', async () => {
      const r = await boot([LOCAL]);
      expect(r.select(bearer('abc'))).to.equal(undefined);
      expect(r.select({ kind: 'kit-unknown' })).to.equal(undefined);
    });

    it('never selects a registered strategy that is not listed', async () => {
      const r = await boot([LOCAL]);
      expect(r.select(bearer('spt_x'))).to.equal(undefined);
    });

    it('asks the next candidate when accepts returns false', async () => {
      const r = await boot([TOKEN, JWT, PLAIN]);
      expect(r.select(bearer('spt_abc'))?.name).to.equal('token');
      expect(r.select(bearer('a.b.c'))?.name).to.equal('jwt');
      expect(r.select(bearer('opaque'))?.name).to.equal('plain');
    });

    it('returns undefined when every candidate declines', async () => {
      const r = await boot([TOKEN, JWT]);
      expect(r.select(bearer('opaque'))).to.equal(undefined);
    });

    it('treats a throwing or non-boolean accepts as a decline', async () => {
      const r = await boot([entry('throwing', 'ThrowingBearer'), entry('truthy', 'TruthyBearer'), PLAIN]);
      expect(r.select(bearer('x'))?.name).to.equal('plain');
    });

    it('returns undefined for malformed credentials', async () => {
      const r = await boot([LOCAL, PLAIN]);
      expect(r.select(null as unknown as Credentials)).to.equal(undefined);
      expect(r.select({} as unknown as Credentials)).to.equal(undefined);
      expect(r.select({ kind: 1 } as unknown as Credentials)).to.equal(undefined);
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
