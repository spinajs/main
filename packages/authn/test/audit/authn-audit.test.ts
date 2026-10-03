import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { AuthnAudit, AuthnEventSink, DEFAULT_AUDIT_SAMPLE_USE, DEFAULT_AUDIT_SINK_TIMEOUT_MS, LogAuthnAuditSink, readAuditConfig } from '../../src/index.js';
import type { AuditLog, AuthnEvent, AuthnEventType } from '../../src/index.js';
import { useTestLog } from './test-log.js';

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

class AuditTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { authn: { audit: {} } };
  }
}

class CapturingLog implements AuditLog {
  readonly lines: string[] = [];
  info(m: string): void {
    this.lines.push(`info ${m}`);
  }
  warn(m: string): void {
    this.lines.push(`warn ${m}`);
  }
}

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

  let cfg: Configuration;

  useTestLog();

  before(async () => {
    DI.register(AuditTestConfiguration).as(Configuration);
    cfg = await DI.resolve(Configuration);
    expect(cfg).to.be.instanceOf(AuditTestConfiguration);
    for (const t of BASE) DI.register(t).as(AuthnEventSink);
    DI.register(NotASink).asSelf();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    DI.uncache(AuthnAudit);
    DI.uncache(LogAuthnAuditSink);
    for (const t of BASE) DI.uncache(t);
  });

  after(() => {
    for (const t of [...BASE, NotASink, AuditTestConfiguration]) {
      DI.uncache(t);
      DI.unregister(t);
    }
  });

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

  async function boot(audit: unknown, opts?: { random?: () => number; log?: AuditLog }): Promise<AuthnAudit> {
    cfg.set('authn.audit', audit);
    if (!opts) return DI.resolve(AuthnAudit);
    const a = new AuthnAudit(DI.RootContainer, opts);
    await a.resolve();
    return a;
  }

  async function bootFails(audit: unknown, ...parts: string[]): Promise<string> {
    let error: unknown;
    try {
      await boot(audit);
    } catch (e) {
      error = e;
    }
    expect(error, 'the boot fails').to.be.instanceOf(InvalidOption);
    for (const p of parts) expect((error as Error).message).to.contain(p);
    expect(DI.has(AuthnAudit)).to.equal(false);
    return (error as Error).message;
  }

  const sinkNames = (a: AuthnAudit): string[] => a.sinks().map((s) => s.constructor.name);

  describe('sinks', () => {
    it('publishes every event to every registered sink: listed ones first, in list order, then the rest', async () => {
      const a = await boot({ sinks: ['ThirdSink', 'FirstSink'] });
      await a.publish(ev('login', 'failure'));
      await a.publish(ev('login'));
      expect(calls).to.deep.equal(['ThirdSink:login', 'FirstSink:login', 'SecondSink:login', 'ThirdSink:login', 'FirstSink:login', 'SecondSink:login']);
      expect(sinkNames(a).slice(0, 2)).to.deep.equal(['ThirdSink', 'FirstSink']);
      expect(sinkNames(a)).to.include('LogAuthnAuditSink').and.include('SecondSink');
      const first = (await DI.resolve(FirstSink)).events.map((e) => e.outcome);
      const second = (await DI.resolve(SecondSink)).events.map((e) => e.outcome);
      expect(first).to.deep.equal(['failure', 'success']);
      expect(second).to.deep.equal(first);
    });

    it('keeps every registered sink when the list is missing or empty', async () => {
      for (const audit of [{}, { sinks: [] }, undefined]) {
        DI.uncache(AuthnAudit);
        const a = await boot(audit);
        for (const t of [...BASE, LogAuthnAuditSink]) expect(sinkNames(a)).to.include(t.name);
      }
    });

    it('resolves the sinks through DI as singletons, each once', async () => {
      const a = await boot({ sinks: ['FirstSink', 'FirstSink'] });
      expect(a.sinks()[0]).to.equal(await DI.resolve(FirstSink));
      expect(sinkNames(a).filter((n) => n === 'FirstSink')).to.have.length(1);
      expect(Object.isFrozen(a.sinks())).to.equal(true);
    });

    it('awaits each sink before calling the next', async () => {
      await withSinks([SlowSink], async () => {
        const a = await boot({ sinks: ['SlowSink', 'FirstSink'] });
        await a.publish(ev('logout'));
        expect(calls.slice(0, 3)).to.deep.equal(['SlowSink:start:logout', 'SlowSink:end:logout', 'FirstSink:logout']);
      });
    });

    it('a failing sink stops neither the other sinks nor the caller', async () => {
      await withSinks([RejectingSink, ThrowingSink], async () => {
        const log = new CapturingLog();
        const a = await boot({ sinks: ['RejectingSink', 'ThrowingSink', 'FirstSink'] }, { log });
        await a.publish(ev('login'));
        expect(calls).to.deep.equal(['RejectingSink:login', 'ThrowingSink:login', 'FirstSink:login', 'SecondSink:login', 'ThirdSink:login']);
        const failures = log.lines.filter((l) => l.startsWith('warn'));
        expect(failures).to.have.length(2);
        expect(failures[0]).to.contain('RejectingSink').and.contain('login').and.contain('Error');
        expect(failures[1]).to.contain('ThrowingSink').and.contain('TypeError');
      });
    });

    it('logs a sink failure without the error message or event values', async () => {
      await withSinks([QuietRejectingSink], async () => {
        const log = new CapturingLog();
        const a = await boot({ sinks: ['QuietRejectingSink'] }, { log });
        await a.publish(ev('login'));
        const all = log.lines.join(' ');
        expect(all).to.contain('QuietRejectingSink');
        expect(all).to.not.contain('hunter2');
        expect(all).to.not.contain(IP);
        expect(all).to.not.contain('u-1');
      });
    });

    it('moves on from a sink that does not settle within authn.audit.sinkTimeoutMs', async () => {
      await withSinks([HangingSink], async () => {
        const log = new CapturingLog();
        const a = await boot({ sinks: ['HangingSink', 'FirstSink'], sinkTimeoutMs: 20 }, { log });
        const started = Date.now();
        await a.publish(ev('login'));
        expect(Date.now() - started).to.be.below(1000);
        expect(calls).to.deep.equal(['HangingSink:login', 'FirstSink:login', 'SecondSink:login', 'ThirdSink:login']);
        expect(log.lines).to.have.length(1);
        expect(log.lines[0]).to.match(/^warn /);
        expect(log.lines[0]).to.contain('"HangingSink"').and.contain('timed out').and.contain('"login"');
        expect(log.lines[0]).to.not.contain(IP);
        expect(log.lines[0]).to.not.contain('u-1');
      });
    });

    it('ignores a timed-out sink that rejects later, without an unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (r: unknown) => unhandled.push(r);
      process.on('unhandledRejection', onUnhandled);
      try {
        await withSinks([LateRejectingSink], async () => {
          const log = new CapturingLog();
          const a = await boot({ sinks: ['LateRejectingSink'], sinkTimeoutMs: 10 }, { log });
          await a.publish(ev('login'));
          await new Promise((r) => setTimeout(r, 80));
          expect(log.lines).to.have.length(1);
          expect(log.lines[0]).to.contain('timed out');
        });
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).to.deep.equal([]);
    });

    it('hands every sink its own deep frozen copy, so no sink changes the caller or the next sink', async () => {
      await withSinks([MutatingSink], async () => {
        const a = await boot({ sinks: ['MutatingSink', 'FirstSink'] });
        const e: AuthnEvent = { ...ev('login'), actor: { type: 'user', id: 'u-9' }, data: { step: 'totp', nested: { list: ['a'] } } };
        const before = JSON.stringify(e);
        await a.publish(e);
        expect(JSON.stringify(e), "the caller's event").to.equal(before);
        const mutated = (await DI.resolve(MutatingSink)).events[0];
        const seen = (await DI.resolve(FirstSink)).events[0];
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

    it('fails boot on an unknown sink name, naming it', async () => {
      await bootFails({ sinks: ['FirstSink', 'DbAuthnAuditSink'] }, 'authn.audit.sinks', '"DbAuthnAuditSink"');
    });

    it('does not find a class that is not registered as an AuthnEventSink', async () => {
      await bootFails({ sinks: ['NotASink'] }, '"NotASink"');
    });

    it('collapses names that config files repeat (arrays merge by concat)', async () => {
      cfg.set('authn.audit', { sinks: ['SecondSink', 'FirstSink'] });
      cfg.merge('authn', { audit: { sinks: ['SecondSink'] } });
      expect(cfg.get('authn.audit.sinks')).to.have.length(3);
      const a = await DI.resolve(AuthnAudit);
      expect(sinkNames(a).slice(0, 2)).to.deep.equal(['SecondSink', 'FirstSink']);
      expect(sinkNames(a).filter((n) => n === 'SecondSink')).to.have.length(1);
      expect(sinkNames(a)).to.include('ThirdSink');
    });

    it('resolves sinks registered as factories; a factory that returns a non-sink fails boot', async () => {
      const shared = new FirstSink();
      const good = { FactorySink: () => shared }.FactorySink;
      const bad = { BrokenSink: () => ({}) }.BrokenSink;
      const list = DI.RootContainer.getRegisteredTypes(AuthnEventSink);
      DI.register(good).as(AuthnEventSink);
      try {
        const a = await boot({ sinks: ['FactorySink'] });
        expect(a.sinks()[0]).to.equal(shared);
        DI.uncache(AuthnAudit);
        DI.register(bad).as(AuthnEventSink);
        await bootFails({}, '"BrokenSink"', 'AuthnEventSink');
      } finally {
        // DI.unregister matches by type name, and every factory's type name is 'Function'.
        for (const f of [good, bad]) if (list.includes(f as never)) list.splice(list.indexOf(f as never), 1);
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
      expect(DEFAULT_AUDIT_SAMPLE_USE).to.equal(0.01);
      expect(await run(undefined, 0.0099, [ev('token.use')])).to.deep.equal(['token.use']);
      expect(await run(undefined, 0.01, [ev('token.use')])).to.deep.equal([]);
    });

    it('drops a use event when the random source gives a value that is not a number in [0, 1)', async () => {
      expect(await run(1, Number.NaN, [ev('token.use')])).to.deep.equal([]);
    });
  });

  describe('configuration', () => {
    it('reads the defaults', () => {
      expect(DEFAULT_AUDIT_SINK_TIMEOUT_MS).to.equal(2000);
      expect(readAuditConfig(undefined)).to.deep.equal({ sinks: undefined, sampleUse: 0.01, hashIdentifiers: true, hashKey: null, sinkTimeoutMs: 2000 });
      expect(readAuditConfig({ sinks: ['A'], sampleUse: 0.5, hashIdentifiers: false, hashKey: { secret: 'k'.repeat(32) }, sinkTimeoutMs: 250 })).to.deep.equal({
        sinks: ['A'],
        sampleUse: 0.5,
        hashIdentifiers: false,
        hashKey: 'k'.repeat(32),
        sinkTimeoutMs: 250,
      });
      expect(readAuditConfig({ hashKey: { secret: null } }).hashKey).to.equal(null);
    });

    it('fails boot on malformed authn.audit values', async () => {
      await bootFails('LogAuthnAuditSink', 'authn.audit');
      await bootFails({ sink: ['FirstSink'] }, 'authn.audit', '"sink"');
      await bootFails({ sinks: 'FirstSink' }, 'authn.audit.sinks');
      await bootFails({ sinks: ['FirstSink', ''] }, 'authn.audit.sinks');
      await bootFails({ sinks: [null] }, 'authn.audit.sinks');
      for (const v of [-0.01, 1.01, Number.NaN, '0.5', Number.POSITIVE_INFINITY]) await bootFails({ sampleUse: v }, 'authn.audit.sampleUse');
      await bootFails({ hashIdentifiers: 'yes' }, 'authn.audit.hashIdentifiers');
      await bootFails({ hashKey: 'k'.repeat(40) }, 'authn.audit.hashKey');
      await bootFails({ hashKey: { secret: 'short' } }, 'authn.audit.hashKey', '32');
      await bootFails({ hashKey: { secret: 7 } }, 'authn.audit.hashKey');
      await bootFails({ hashKey: { secret: 'k'.repeat(32), version: 1 } }, 'authn.audit.hashKey', '"version"');
      for (const v of [0, -1, 1.5, 60001, '20', Number.NaN]) await bootFails({ sinkTimeoutMs: v }, 'authn.audit.sinkTimeoutMs');
    });

    it('does not echo config values', async () => {
      expect(await bootFails({ hashKey: { secret: 'hunter2-hunter2' } }, 'authn.audit.hashKey')).to.not.contain('hunter2');
      expect(await bootFails({ hashKey: 'hunter2-hunter2-hunter2-hunter2-hunter2' }, 'authn.audit.hashKey')).to.not.contain('hunter2');
      expect(await bootFails({ sampleUse: 'hunter2' }, 'authn.audit.sampleUse')).to.not.contain('hunter2');
      expect(await bootFails('hunter2', 'authn.audit')).to.not.contain('hunter2');
    });

    it('LogAuthnAuditSink is registered as an AuthnEventSink', () => {
      expect((DI.getRegisteredTypes(AuthnEventSink) ?? []).includes(LogAuthnAuditSink as never)).to.equal(true);
    });
  });
});
