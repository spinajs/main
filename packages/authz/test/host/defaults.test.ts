import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { Log, renderTemplate } from '@spinajs/log-common';

import { InProcessChangeBus, LogDecisionAudit, AuthzClock, SystemClock, isProduction, engineLog, ChangeBus, DecisionAudit, DecisionCache, LruDecisionCache, TRUE } from '@spinajs/authz';
import type { AuthzChange, Decision } from '@spinajs/authz';
import { TestLog, installTestLog } from '@spinajs/authz-testing';

const expect = chai.expect;

const change = (tags: string[] = ['t']): AuthzChange => ({ tags, at: new Date(0) });

describe('InProcessChangeBus', () => {
  let uninstallLog: () => void;
  before(() => (uninstallLog = installTestLog()));
  after(() => uninstallLog());
  beforeEach(() => TestLog.clear());

  it('is a ChangeBus', () => {
    expect(new InProcessChangeBus()).to.be.instanceOf(ChangeBus);
  });

  it('calls subscribers in subscription order with the change', async () => {
    const bus = new InProcessChangeBus();
    const seen: string[] = [];
    bus.subscribe((c) => seen.push(`a:${c.tags[0]}`));
    bus.subscribe((c) => seen.push(`b:${c.tags[0]}`));
    await bus.publish(change(['x']));
    expect(seen).to.deep.equal(['a:x', 'b:x']);
  });

  it('a throwing subscriber does not stop the others', async () => {
    const bus = new InProcessChangeBus();
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => seen.push(2));
    await bus.publish(change());
    expect(seen).to.deep.equal([2]);
  });

  it('unsubscribe stops delivery and is idempotent', async () => {
    const bus = new InProcessChangeBus();
    let n = 0;
    const off = bus.subscribe(() => n++);
    await bus.publish(change());
    off();
    off();
    await bus.publish(change());
    expect(n).to.equal(1);
  });

  it('logs a throwing or rejecting subscriber without an unhandled rejection', async () => {
    const bus = new InProcessChangeBus();
    bus.subscribe(() => {
      throw new Error('sync-fail');
    });
    bus.subscribe((() => Promise.reject(new Error('async-fail'))) as never);
    await bus.publish(change());
    await new Promise((r) => setImmediate(r));
    const errors = TestLog.lines.filter((l) => l.level === 'error').map((l) => String((l.args[0] as { error?: Error }).error?.message));
    expect(errors.some((e) => e.includes('sync-fail'))).to.equal(true);
    expect(errors.some((e) => e.includes('async-fail'))).to.equal(true);
  });

  it('gives two independent subscriptions for the same function', async () => {
    const bus = new InProcessChangeBus();
    let n = 0;
    const fn = () => void n++;
    const off1 = bus.subscribe(fn);
    bus.subscribe(fn);
    await bus.publish(change());
    expect(n).to.equal(2);
    off1();
    await bus.publish(change());
    expect(n).to.equal(3);
  });

  it('a subscriber unsubscribing during publish does not break the round', async () => {
    const bus = new InProcessChangeBus();
    const seen: string[] = [];
    const off = bus.subscribe(() => {
      seen.push('a');
      off();
    });
    bus.subscribe(() => seen.push('b'));
    await bus.publish(change());
    expect(seen).to.deep.equal(['a', 'b']);
  });
});

class FakeLog {
  lines: Array<{ level: string; message: string; args: unknown[] }> = [];
  error(...args: unknown[]) {
    this.push('error', args);
  }
  warn(...args: unknown[]) {
    this.push('warn', args);
  }
  debug(...args: unknown[]) {
    this.push('debug', args);
  }
  info(...args: unknown[]) {
    this.push('info', args);
  }
  private push(level: string, [first, ...rest]: unknown[]) {
    if (typeof first === 'string') this.lines.push({ level, message: first, args: rest });
    else this.lines.push({ level, message: renderTemplate(rest[0] as string, first as Record<string, unknown>), args: rest.slice(1) });
  }
}

describe('LogDecisionAudit', () => {
  const principal = { type: 'user', id: 'u1' };

  it('is a DecisionAudit', () => {
    expect(new LogDecisionAudit()).to.be.instanceOf(DecisionAudit);
  });

  it('logs deny at warn and the other kinds at info', () => {
    const log = new FakeLog();
    const audit = new LogDecisionAudit(log as never);
    audit.record({ kind: 'deny', principal, permission: 'doc.read', reason: 'no grant' });
    audit.record({ kind: 'runAs', principal, reason: 'cron' });
    expect(log.lines.map((l) => l.level)).to.deep.equal(['warn', 'info']);
    expect(log.lines[0]!.message).to.contain('deny').and.to.contain('doc.read');
  });

  it('keeps only durationMs of the trace', () => {
    const log = new FakeLog();
    const audit = new LogDecisionAudit(log as never);
    audit.record({ kind: 'explain', principal, trace: { durationMs: 12, secret: 'steps' } as never });
    const text = JSON.stringify(log.lines);
    expect(text).to.contain('12');
    expect(text).to.not.contain('steps');
  });

  it('keeps raw newlines out of the line', () => {
    const log = new FakeLog();
    const audit = new LogDecisionAudit(log as never);
    audit.record({ kind: 'deny', principal: { type: 'user', id: 'a\nb\rc' }, permission: 'x\ny', reason: 'r\nz', resource: { type: 't\n', id: 'i\n' } as never });
    expect(log.lines[0]!.message).to.not.match(/[\r\n]/);
  });

  it('quotes a value that could fake a field', () => {
    const log = new FakeLog();
    const audit = new LogDecisionAudit(log as never);
    audit.record({ kind: 'deny', principal: { type: 'user', id: 'u1 permission=x' } });
    expect(log.lines[0]!.message).to.contain('principal=user:"u1 permission=x"');
  });

  it('names the command kind of an admin record', () => {
    const log = new FakeLog();
    const audit = new LogDecisionAudit(log as never);
    audit.record({ kind: 'admin', principal, command: { kind: 'grant', x: 1 } });
    audit.record({ kind: 'admin', principal, command: 'oops' });
    expect(log.lines[0]!.message).to.contain('command=grant');
    expect(log.lines[1]!.message).to.not.contain('command=');
  });

  it('never throws, even when the logger does or the record is malformed', () => {
    const bad = {
      error() {
        throw new Error('x');
      },
      warn() {
        throw new Error('x');
      },
      debug() {},
      info() {
        throw new Error('x');
      },
    };
    const audit = new LogDecisionAudit(bad as never);
    expect(() => audit.record({ kind: 'deny', principal })).to.not.throw();
    expect(() => audit.record(null as never)).to.not.throw();
  });
});

describe('AuthzClock', () => {
  it('SystemClock is an AuthzClock giving a fresh Date', () => {
    const c = new SystemClock();
    expect(c).to.be.instanceOf(AuthzClock);
    const a = c.now();
    expect(a).to.be.instanceOf(Date);
    expect(c.now()).to.not.equal(a);
    expect(Math.abs(a.getTime() - Date.now())).to.be.lessThan(1000);
  });
});

describe('default DecisionCache', () => {
  const decision = (): Decision =>
    Object.freeze({
      allowed: true,
      permission: 'p',
      resource: { type: 'doc' },
      principal: { type: 'user', id: 'u' },
      residual: TRUE,
      fields: { read: ['*'], write: ['*'] },
      roles: {},
      domain: 'default',
    }) as Decision;

  it('gives a fresh LruDecisionCache per resolve', () => {
    const a = DI.resolve(DecisionCache);
    const b = DI.resolve(DecisionCache);
    expect(a).to.be.instanceOf(LruDecisionCache);
    expect(b).to.be.instanceOf(LruDecisionCache);
    expect(a).to.not.equal(b);
  });

  it('passes the options to the instance', () => {
    const c = DI.resolve(DecisionCache, [{ maxEntries: 1 }]) as LruDecisionCache;
    c.set('a', decision(), [], 1000);
    c.set('b', decision(), [], 1000);
    expect(c.size).to.equal(1);
    expect(c.get('a')).to.equal(undefined);
  });
});

describe('isProduction', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the configured flag wins over the environment', () => {
    process.env.APP_ENV = 'prod';
    expect(isProduction(false)).to.equal(false);
    process.env.APP_ENV = 'dev';
    expect(isProduction(true)).to.equal(true);
  });

  it('without a flag follows APP_ENV, then NODE_ENV', () => {
    process.env.APP_ENV = 'prod';
    expect(isProduction(undefined)).to.equal(true);
    process.env.APP_ENV = 'development';
    process.env.NODE_ENV = 'production';
    expect(isProduction(undefined)).to.equal(false);
    delete process.env.APP_ENV;
    expect(isProduction(undefined)).to.equal(true);
    process.env.NODE_ENV = 'dev';
    expect(isProduction(undefined)).to.equal(false);
    delete process.env.NODE_ENV;
    expect(isProduction(undefined)).to.equal(false);
  });

  it('a flag that is not a boolean follows the environment', () => {
    process.env.APP_ENV = 'prod';
    for (const flag of [0, '', null, 'false', 1]) {
      expect(isProduction(flag as never), String(flag)).to.equal(true);
    }
    process.env.APP_ENV = 'dev';
    for (const flag of [1, 'true']) {
      expect(isProduction(flag as never), String(flag)).to.equal(false);
    }
  });
});

describe('engineLog', () => {
  it('throws on a write while no Log is registered, without registering one', () => {
    const log = engineLog('authz-test');
    expect(() => log.warn('w')).to.throw(/no Log is registered/);
    expect(DI.has(Log)).to.equal(false);
  });

  it('resolves the Log on the first write, so one registered after the writer was made is used', () => {
    class LateLog {
      static lines: string[] = [];
      warn(message: string) {
        LateLog.lines.push(message);
      }
    }
    const log = engineLog('authz-test-late');
    DI.register(LateLog as never).as(Log as never);
    try {
      log.warn('first');
    } finally {
      DI.uncache(LateLog as never);
      DI.unregister(LateLog as never);
    }
    expect(LateLog.lines).to.deep.equal(['first']);
  });

  it('writes through the resolved Log and resolves it once', () => {
    const fake = new FakeLog();
    let resolved = 0;
    const log = engineLog('authz-test2', () => {
      resolved++;
      return fake as unknown as Log;
    });
    log.warn('hello');
    log.debug('dbg');
    expect(fake.lines.map((l) => l.level)).to.deep.equal(['warn', 'debug']);
    expect(resolved).to.equal(1);
  });

  it('forwards warnOnce to the resolved Log', () => {
    const calls: unknown[][] = [];
    const log = engineLog('authz-test3', () => ({ warnOnce: (...a: unknown[]) => (calls.push(a), true) }) as unknown as Log);
    expect(log.warnOnce('k', 'w')).to.equal(true);
    expect(calls).to.deep.equal([['k', 'w']]);
  });
});
