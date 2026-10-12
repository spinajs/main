import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { CONFIGURATION_CONTAINER_KEY, Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';

import { AUTHN_CONFIGURATION_SCHEMA, AuthnAudit, AuthnEventSink, LogAuthnAuditSink } from '../../src/index.js';
import type { AuditConfig, AuthnEvent, AuthnEventType } from '../../src/index.js';
import { configurationOf } from '../behaviour/harness.js';
import { TestLog, useTestLog } from './test-log.js';

const expect = chai.expect;

const calls: string[] = [];

abstract class Recording extends AuthnEventSink {
  readonly events: AuthnEvent[] = [];
  async publish(e: AuthnEvent): Promise<void> {
    calls.push(`${this.constructor.name}:${e.type}`);
    this.events.push(e);
  }
}

class FirstSink extends Recording {}
class SecondSink extends Recording {}
class ThirdSink extends Recording {}
class LastSink extends Recording {}

class SlowSink extends AuthnEventSink {
  async publish(e: AuthnEvent): Promise<void> {
    calls.push(`SlowSink:start:${e.type}`);
    await new Promise((r) => setTimeout(r, 20));
    calls.push(`SlowSink:end:${e.type}`);
  }
}

class RejectingSink extends AuthnEventSink {
  async publish(e: AuthnEvent): Promise<void> {
    calls.push(`RejectingSink:${e.type}`);
    throw new Error(`db down for ${e.ip ?? ''} hunter2`);
  }
}

class QuietRejectingSink extends RejectingSink {}

class ThrowingSink extends AuthnEventSink {
  publish(e: AuthnEvent): Promise<void> {
    calls.push(`ThrowingSink:${e.type}`);
    throw new TypeError(`sync failure ${e.ip ?? ''}`);
  }
}

class HangingSink extends AuthnEventSink {
  publish(e: AuthnEvent): Promise<void> {
    calls.push(`HangingSink:${e.type}`);
    return new Promise(() => undefined);
  }
}

class LateRejectingSink extends AuthnEventSink {
  publish(e: AuthnEvent): Promise<void> {
    calls.push(`LateRejectingSink:${e.type}`);
    return new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 40));
  }
}

class MutatingSink extends AuthnEventSink {
  readonly events: AuthnEvent[] = [];
  async publish(e: AuthnEvent): Promise<void> {
    this.events.push(e);
    const tries: Array<() => void> = [() => ((e as { type: string }).type = 'logout'), () => ((e.identity as { id: string }).id = 'admin'), () => ((e.actor as { id: string }).id = 'admin'), () => ((e.data as { step: string }).step = 'none'), () => (e.data as { nested: { list: string[] } }).nested.list.push('x'), () => e.at.setTime(0)];
    for (const t of tries) {
      try {
        t();
      } catch {
        // frozen
      }
    }
  }
}

class NotASink {
  async publish(): Promise<void> {}
}

const BASE: Class<unknown>[] = [FirstSink, SecondSink, ThirdSink];

class ChildSink extends Recording {}

// What AuthnAudit itself logs; LogAuthnAuditSink writes to the same logger.
const auditorLines = (): string[] => TestLog.of('authn-audit').filter((e) => e.message.startsWith('AuthnAudit:')).map((e) => `${e.level} ${e.message}`);

const IP = '203.0.113.7';

const ev = (type: AuthnEventType, outcome: 'success' | 'failure' = 'success'): AuthnEvent => ({
  type,
  outcome,
  at: new Date('2026-10-03T10:00:00Z'),
  identity: { type: 'user', id: 'u-1' },
  ip: IP,
  strategy: 'local',
});

describe('AuthnAudit', function () {
  this.timeout(15000);

  const children: IContainer[] = [];

  useTestLog();

  before(() => {
    for (const t of BASE) DI.register(t).as(AuthnEventSink);
    DI.register(NotASink).asSelf();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
    for (const t of BASE) DI.uncache(t);
  });

  after(() => {
    for (const t of [...BASE, NotASink]) {
      DI.uncache(t);
      DI.unregister(t);
    }
  });

  async function childWith(audit: unknown): Promise<{ child: IContainer; configuration: Configuration }> {
    const child = DI.RootContainer.child();
    children.push(child);
    child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    child.register(configurationOf({ authn: { audit } }, undefined, true)).as(Configuration);
    return { child, configuration: await child.resolve(Configuration) };
  }

  async function withSinks(types: Class<unknown>[], fn: () => Promise<void>): Promise<void> {
    for (const t of types) DI.register(t).as(AuthnEventSink);
    try {
      await fn();
    } finally {
      for (const t of types) {
        DI.uncache(t);
        DI.unregister(t);
      }
    }
  }

  async function boot(audit: unknown, opts?: { random?: () => number }): Promise<AuthnAudit> {
    const { child } = await childWith(audit);
    if (!opts) return child.resolve(AuthnAudit);
    const a = new AuthnAudit(child, opts);
    (a as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;
    await a.resolve();
    return a;
  }

  async function failure(audit: unknown): Promise<unknown> {
    try {
      await boot(audit);
    } catch (e) {
      return e;
    }
    return undefined;
  }

  async function bootFails(audit: unknown, ...paths: string[]): Promise<string> {
    const error = await failure(audit);
    expect(error, 'the boot fails').to.be.instanceOf(InvalidConfiguration);
    const found = (error as InvalidConfiguration).violations.map((v) => v.path);
    for (const p of paths) expect(found).to.include(p);
    return (error as Error).message;
  }

  const sinkNames = (a: AuthnAudit): string[] => a.sinks().map((s) => s.constructor.name);

  describe('sinks', () => {
    it('publishes every event to every registered sink, in registration order', async () => {
      const a = await boot({});
      await a.publish(ev('login', 'failure'));
      await a.publish(ev('login'));
      expect(calls).to.deep.equal(['FirstSink:login', 'SecondSink:login', 'ThirdSink:login', 'FirstSink:login', 'SecondSink:login', 'ThirdSink:login']);
      expect(sinkNames(a)).to.include('LogAuthnAuditSink');
      const first = (await DI.resolve(FirstSink)).events.map((e) => e.outcome);
      const second = (await DI.resolve(SecondSink)).events.map((e) => e.outcome);
      expect(first).to.deep.equal(['failure', 'success']);
      expect(second).to.deep.equal(first);
    });

    it('keeps every registered sink when authn.audit is unset', async () => {
      for (const audit of [{}, undefined]) {
        const a = await boot(audit);
        for (const t of [...BASE, LogAuthnAuditSink]) expect(sinkNames(a)).to.include(t.name);
      }
    });

    it('resolves the sinks through DI as singletons, each once', async () => {
      const a = await boot({});
      expect(a.sinks()).to.include(await DI.resolve(FirstSink));
      expect(sinkNames(a).filter((n) => n === 'FirstSink')).to.have.length(1);
      expect(Object.isFrozen(a.sinks())).to.equal(true);
    });

    it('awaits each sink before calling the next', async () => {
      await withSinks([SlowSink, LastSink], async () => {
        const a = await boot({});
        await a.publish(ev('logout'));
        expect(calls.slice(-3)).to.deep.equal(['SlowSink:start:logout', 'SlowSink:end:logout', 'LastSink:logout']);
      });
    });

    it('a failing sink stops neither the other sinks nor the caller', async () => {
      await withSinks([RejectingSink, ThrowingSink, LastSink], async () => {
        const a = await boot({});
        await a.publish(ev('login'));
        expect(calls).to.deep.equal(['FirstSink:login', 'SecondSink:login', 'ThirdSink:login', 'RejectingSink:login', 'ThrowingSink:login', 'LastSink:login']);
        const failures = auditorLines().filter((l) => l.startsWith('warn'));
        expect(failures).to.have.length(2);
        expect(failures[0]).to.contain('RejectingSink').and.contain('login').and.contain('Error');
        expect(failures[1]).to.contain('ThrowingSink').and.contain('TypeError');
      });
    });

    it('logs a sink failure without the error message or event values', async () => {
      await withSinks([QuietRejectingSink], async () => {
        const a = await boot({});
        await a.publish(ev('login'));
        const all = auditorLines().join(' ');
        expect(all).to.contain('QuietRejectingSink');
        expect(all).to.not.contain('hunter2');
        expect(all).to.not.contain(IP);
        expect(all).to.not.contain('u-1');
      });
    });

    it('moves on from a sink that does not settle within authn.audit.sinkTimeoutMs', async () => {
      await withSinks([HangingSink, LastSink], async () => {
        const a = await boot({ sinkTimeoutMs: 20 });
        const started = Date.now();
        await a.publish(ev('login'));
        expect(Date.now() - started).to.be.below(1000);
        expect(calls).to.deep.equal(['FirstSink:login', 'SecondSink:login', 'ThirdSink:login', 'HangingSink:login', 'LastSink:login']);
        expect(auditorLines()).to.have.length(1);
        expect(auditorLines()[0]).to.match(/^warn /);
        expect(auditorLines()[0]).to.contain('"HangingSink"').and.contain('timed out').and.contain('"login"');
        expect(auditorLines()[0]).to.not.contain(IP);
        expect(auditorLines()[0]).to.not.contain('u-1');
      });
    });

    it('ignores a timed-out sink that rejects later, without an unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (r: unknown) => unhandled.push(r);
      process.on('unhandledRejection', onUnhandled);
      try {
        await withSinks([LateRejectingSink], async () => {
          const a = await boot({ sinkTimeoutMs: 10 });
          await a.publish(ev('login'));
          await new Promise((r) => setTimeout(r, 80));
          expect(auditorLines()).to.have.length(1);
          expect(auditorLines()[0]).to.contain('timed out');
        });
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).to.deep.equal([]);
    });

    it('hands every sink its own deep frozen copy, so no sink changes the caller or the next sink', async () => {
      await withSinks([MutatingSink, LastSink], async () => {
        const a = await boot({});
        const e: AuthnEvent = { ...ev('login'), actor: { type: 'user', id: 'u-9' }, data: { step: 'totp', nested: { list: ['a'] } } };
        const before = JSON.stringify(e);
        await a.publish(e);
        expect(JSON.stringify(e), "the caller's event").to.equal(before);
        const mutated = (await DI.resolve(MutatingSink)).events[0];
        const seen = (await DI.resolve(LastSink)).events[0];
        expect(JSON.stringify(seen), 'what the next sink sees').to.equal(before);
        expect(seen).to.not.equal(e);
        expect(seen).to.not.equal(mutated);
        expect(seen.identity).to.not.equal(e.identity);
        expect(seen.at).to.not.equal(mutated.at);
        for (const o of [seen, seen.identity, seen.actor, seen.data, (seen.data as { nested: object }).nested, (seen.data as { nested: { list: object } }).nested.list]) {
          expect(Object.isFrozen(o)).to.equal(true);
        }
      });
    });

    it('does not take a class that is not registered as an AuthnEventSink', async () => {
      expect(sinkNames(await boot({}))).to.not.include('NotASink');
    });

    it('resolves sinks registered as factories', async () => {
      const shared = new FirstSink();
      const factory = { FactorySink: () => shared }.FactorySink;
      const list = DI.RootContainer.getRegisteredTypes(AuthnEventSink);
      DI.register(factory).as(AuthnEventSink);
      try {
        expect((await boot({})).sinks()).to.include(shared);
      } finally {
        // DI.unregister matches by type name, and every factory's type name is 'Function'.
        list.splice(list.indexOf(factory as never), 1);
      }
    });

    it('keeps unnamed factory sinks apart', async () => {
      const one = new FirstSink();
      const two = new SecondSink();
      const factories = [() => one, () => two];
      expect(factories.map((f) => f.name)).to.deep.equal(['', '']);
      const list = DI.RootContainer.getRegisteredTypes(AuthnEventSink);
      for (const f of factories) DI.register(f).as(AuthnEventSink);
      try {
        const a = await boot({});
        expect(a.sinks()).to.include(one).and.include(two);
      } finally {
        for (const f of factories) list.splice(list.indexOf(f as never), 1);
      }
    });

    it('throws when used before resolve', async () => {
      const a = new AuthnAudit(DI.RootContainer);
      let error: unknown;
      try {
        await a.publish(ev('login'));
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(Error);
      expect(() => a.sinks()).to.throw();
    });
  });

  describe('sampling', () => {
    const firstOnly = (): string[] => calls.filter((c) => c.startsWith('FirstSink:')).map((c) => c.split(':')[1]);

    const run = async (sampleUse: number | undefined, random: number, events: AuthnEvent[]): Promise<string[]> => {
      calls.length = 0;
      const audit = sampleUse === undefined ? {} : { sampleUse };
      const a = await boot(audit, { random: () => random });
      for (const e of events) await a.publish(e);
      return firstOnly();
    };

    it('publishes token.use and key.use successes with probability sampleUse', async () => {
      const uses = [ev('token.use'), ev('key.use')];
      expect(await run(0.4, 0.5, uses)).to.deep.equal([]);
      expect(await run(0.4, 0.39, uses)).to.deep.equal(['token.use', 'key.use']);
      expect(await run(0, 0, uses)).to.deep.equal([]);
      expect(await run(1, 0.999999, uses)).to.deep.equal(['token.use', 'key.use']);
    });

    it('draws once per event', async () => {
      const draws = [0.1, 0.9, 0.1];
      const a = await boot({ sampleUse: 0.5 }, { random: () => draws.shift() ?? 1 });
      for (let i = 0; i < 3; i++) await a.publish(ev('token.use'));
      expect(firstOnly()).to.deep.equal(['token.use', 'token.use']);
    });

    it('always publishes every other type, and use failures', async () => {
      const others = [ev('login'), ev('token.create'), ev('key.revoke'), ev('session.issue'), ev('token.use', 'failure'), ev('key.use', 'failure')];
      expect(await run(0, 0.99, others)).to.deep.equal(['login', 'token.create', 'key.revoke', 'session.issue', 'token.use', 'key.use']);
    });

    it('defaults sampleUse to 0.01', async () => {
      expect(await run(undefined, 0.0099, [ev('token.use')])).to.deep.equal(['token.use']);
      expect(await run(undefined, 0.01, [ev('token.use')])).to.deep.equal([]);
    });

    it('drops a use event when the random source gives a value that is not a number in [0, 1)', async () => {
      expect(await run(1, Number.NaN, [ev('token.use')])).to.deep.equal([]);
    });
  });

  describe('configuration', () => {
    it('takes the defaults from the schema, also when authn.audit is unset', async () => {
      for (const audit of [{}, undefined]) {
        const a = await boot(audit);
        expect((a as unknown as { Config: AuditConfig }).Config).to.deep.equal({ sampleUse: 0.01, hashIdentifiers: true, sinkTimeoutMs: 2000 });
      }
    });

    it('fails boot on malformed authn.audit values, naming the path of each', async () => {
      await bootFails('LogAuthnAuditSink', 'authn.audit');
      await bootFails({ sink: ['FirstSink'] }, 'authn.audit.sink');
      await bootFails({ typo: 1 }, 'authn.audit.typo');
      await bootFails({ sinks: ['FirstSink'] }, 'authn.audit.sinks');
      for (const v of [-0.01, 1.01, 2, 'half']) await bootFails({ sampleUse: v }, 'authn.audit.sampleUse');
      await bootFails({ hashIdentifiers: 'yes' }, 'authn.audit.hashIdentifiers');
      await bootFails({ hashKey: 'k'.repeat(40) }, 'authn.audit.hashKey');
      await bootFails({ hashKey: { secret: 'short' } }, 'authn.audit.hashKey.secret');
      await bootFails({ hashKey: { secret: 'k'.repeat(32), version: 1 } }, 'authn.audit.hashKey.version');
      for (const v of [0, -1, 1.5, 60001, Number.NaN]) await bootFails({ sinkTimeoutMs: v }, 'authn.audit.sinkTimeoutMs');
      await bootFails({ hashKey: { secret: 7 } }, 'authn.audit.hashKey.secret');
    });

    it('reports every bad value of one boot', async () => {
      await bootFails({ sampleUse: 2, sinkTimeoutMs: 0, typo: 1 }, 'authn.audit.sampleUse', 'authn.audit.sinkTimeoutMs', 'authn.audit.typo');
    });

    it('does not echo config values', async () => {
      expect(await bootFails({ hashKey: { secret: 'hunter2-hunter2' } }, 'authn.audit.hashKey.secret')).to.not.contain('hunter2');
      expect(await bootFails({ hashKey: 'hunter2-hunter2-hunter2-hunter2-hunter2' }, 'authn.audit.hashKey')).to.not.contain('hunter2');
      expect(await bootFails({ sampleUse: 'hunter2' }, 'authn.audit.sampleUse')).to.not.contain('hunter2');
      expect(await bootFails('hunter2', 'authn.audit')).to.not.contain('hunter2');
    });

    it('keeps the root sinks when a child container registers its own sink', async () => {
      const { child } = await childWith({});
      child.register(ChildSink).as(AuthnEventSink);
      const a = await child.resolve(AuthnAudit);
      await a.publish(ev('login'));
      expect(calls).to.have.members(['FirstSink:login', 'SecondSink:login', 'ThirdSink:login', 'ChildSink:login']);
      expect(sinkNames(a)).to.include('LogAuthnAuditSink');
      expect(a.sinks()).to.include(await DI.resolve(FirstSink));
    });

    it('fails with InvalidOperation, not a TypeError, when the schema is not registered', async () => {
      const child = DI.RootContainer.child();
      children.push(child);
      child.register(configurationOf({}, undefined, true)).as(Configuration);
      await child.resolve(Configuration);
      for (const build of [() => child.resolve(AuthnAudit), async () => (await child.resolve(LogAuthnAuditSink)).publish(ev('login'))]) {
        try {
          await build();
          expect.fail('expected the call to fail');
        } catch (e) {
          expect(e).to.be.instanceOf(InvalidOperation);
          expect((e as Error).message).to.contain('authn.audit is unset');
        }
      }
    });

    it('LogAuthnAuditSink is registered as an AuthnEventSink', () => {
      expect((DI.getRegisteredTypes(AuthnEventSink) ?? []).includes(LogAuthnAuditSink as never)).to.equal(true);
    });
  });
});

describe('AuthnAudit without a Log', function () {
  this.timeout(15000);

  it('fails to resolve', async () => {
    const child = DI.RootContainer.child();
    try {
      child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
      child.register(configurationOf({ authn: { audit: {} } }, undefined, true)).as(Configuration);
      await child.resolve(Configuration);
      const error = await child.resolve(AuthnAudit).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal('Type Log is not registered at container');
    } finally {
      await child.dispose();
    }
  });
});
