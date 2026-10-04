import * as chai from 'chai';
import 'mocha';
import { createHash, createHmac } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { AuthnAudit, AuthnEventSink, LogAuthnAuditSink, auditLog } from '../../src/index.js';
import type { AuditLog, AuthnEvent } from '../../src/index.js';
import { TestLog, useTestLog } from './test-log.js';

const expect = chai.expect;

class CapturingLog implements AuditLog {
  readonly lines: string[] = [];
  readonly levels: string[] = [];
  info(m: string): void {
    this.levels.push('info');
    this.lines.push(m);
  }
  warn(m: string): void {
    this.levels.push('warn');
    this.lines.push(m);
  }
}

const KEY = 'audit-hash-key-0123456789abcdef-0123456789';
const IP = '198.51.100.23';
const HANDLE = 'hdl_k3JxQ0bR7Tz';
const LOGIN = 'alice.smith';
const EMAIL = 'alice@example.com';
const PASSWORD = 'correct horse battery staple';

const hmac = (key: string, input: string): string => createHmac('sha256', key).update(input).digest('base64url');

const event = (over: Partial<AuthnEvent> = {}): AuthnEvent => ({
  type: 'impersonation.start',
  outcome: 'success',
  at: new Date('2026-10-03T10:00:00.000Z'),
  identity: { type: 'user', id: 'u-42' },
  actor: { type: 'user', id: 'u-7' },
  strategy: 'local',
  ip: IP,
  userAgent: `Mozilla/5.0 (${EMAIL})`,
  session: HANDLE,
  data: { login: LOGIN, email: EMAIL, password: PASSWORD, reason: 'support ticket' },
  ...over,
});

function sink(audit: Record<string, unknown> = { hashKey: { secret: KEY } }): { sink: LogAuthnAuditSink; log: CapturingLog } {
  const log = new CapturingLog();
  return { sink: new LogAuthnAuditSink(audit, log), log };
}

describe('LogAuthnAuditSink', () => {
  it('is an AuthnEventSink', () => {
    expect(sink().sink).to.be.instanceOf(AuthnEventSink);
  });

  it('writes one line per event with type, outcome, time, strategy and reason', async () => {
    const { sink: s, log } = sink();
    await s.publish(event());
    await s.publish(event({ type: 'login', outcome: 'failure', reason: 'invalid_credentials', actor: undefined }));
    expect(log.lines).to.have.length(2);
    expect(log.lines[0]).to.match(/^authn audit impersonation\.start success /);
    expect(log.lines[0]).to.contain('at=2026-10-03T10:00:00.000Z').and.contain('strategy=local');
    expect(log.lines[1]).to.match(/^authn audit login failure /);
    expect(log.lines[1]).to.contain('reason=invalid_credentials');
    for (const l of log.lines) expect(l).to.not.contain('\n');
  });

  it('writes failures at warn and successes at info', async () => {
    const { sink: s, log } = sink();
    await s.publish(event());
    await s.publish(event({ outcome: 'failure' }));
    expect(log.levels).to.deep.equal(['info', 'warn']);
  });

  it('writes identity, actor, ip and session as keyed hashes', async () => {
    const { sink: s, log } = sink();
    await s.publish(event());
    const line = log.lines[0];
    for (const raw of ['u-42', 'u-7', IP, HANDLE]) expect(line).to.not.contain(raw);
    expect(line).to.contain(`identity=user:${hmac(KEY, 'principal|user:u-42')}`);
    expect(line).to.contain(`actor=user:${hmac(KEY, 'principal|user:u-7')}`);
    expect(line).to.contain(`ip=${hmac(KEY, `ip|${IP}`)}`);
    expect(line).to.contain(`session=${hmac(KEY, `session|${HANDLE}`)}`);
  });

  it('gives an identity and an actor with the same id the same hash', async () => {
    const { sink: s, log } = sink();
    await s.publish(event({ identity: { type: 'user', id: 'u-7' } }));
    const id = /identity=user:(\S+)/.exec(log.lines[0])![1];
    const actor = /actor=user:(\S+)/.exec(log.lines[0])![1];
    expect(id).to.equal(actor);
  });

  it('never writes data, the user agent, a login, an email or a password', async () => {
    const { sink: s, log } = sink();
    await s.publish(event());
    await s.publish(event({ type: 'login', outcome: 'failure', reason: 'unknown_identity' }));
    const plain = sink({ hashIdentifiers: false });
    await plain.sink.publish(event());
    for (const line of [...log.lines, ...plain.log.lines]) {
      for (const secret of [LOGIN, EMAIL, PASSWORD, 'support ticket', 'Mozilla']) expect(line).to.not.contain(secret);
      expect(line).to.not.contain('data');
    }
  });

  it('with hashIdentifiers false writes plain ids, but still hashes a value that looks like an email', async () => {
    const plain = sink({ hashIdentifiers: false, hashKey: { secret: KEY } });
    await plain.sink.publish(event());
    await plain.sink.publish(event({ identity: { type: 'user', id: EMAIL } }));
    const [first, second] = plain.log.lines;
    expect(first).to.contain('identity=user:u-42').and.contain('actor=user:u-7').and.contain(`ip=${IP}`).and.contain(`session=${HANDLE}`);
    expect(second).to.not.contain(EMAIL);
    expect(second).to.contain(`identity=user:${hmac(KEY, `principal|user:${EMAIL}`)}`);
  });

  it('without a configured key hashes under one random per-process key', async () => {
    const a = sink({});
    const b = sink({});
    await a.sink.publish(event());
    await b.sink.publish(event());
    expect(a.log.lines[0]).to.equal(b.log.lines[0]);
    const h = /ip=(\S+)/.exec(a.log.lines[0])![1];
    expect(h).to.not.equal(hmac(KEY, `ip|${IP}`));
    expect(h).to.not.equal(createHash('sha256').update(`ip|${IP}`).digest('base64url'));
    expect(h).to.not.equal(hmac('', `ip|${IP}`));
  });

  it('two keys give different hashes', async () => {
    const a = sink({ hashKey: { secret: KEY } });
    const b = sink({ hashKey: { secret: `${KEY}-other` } });
    await a.sink.publish(event());
    await b.sink.publish(event());
    expect(/ip=(\S+)/.exec(a.log.lines[0])![1]).to.not.equal(/ip=(\S+)/.exec(b.log.lines[0])![1]);
  });

  it('quotes values that are not plain tokens, so they cannot forge a field or a line', async () => {
    const { sink: s, log } = sink({ hashIdentifiers: false });
    await s.publish(event({ strategy: 'evil\nauthn audit login success identity=user:admin', reason: 'a b', identity: { type: 'us er', id: 'x=y z' } }));
    expect(log.lines).to.have.length(1);
    const line = log.lines[0];
    expect(line).to.not.contain('\n');
    expect(line).to.contain('strategy="evil\\nauthn audit login success identity=user:admin"');
    expect(line).to.contain('reason="a b"');
    expect(line).to.contain('identity="us er":"x=y z"');
  });

  it('escapes Unicode line breaks, C1 controls and direction marks', async () => {
    const { sink: s, log } = sink({ hashIdentifiers: false });
    const marks = [0x2028, 0x2029, 0x85, 0x7f, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0x61c, 0xfeff].map((c) => String.fromCharCode(c));
    await s.publish(event({ reason: `a${marks.join('')}b`, strategy: `x${marks[0]}authn audit login success` }));
    const line = log.lines[0];
    for (const m of marks) expect(line).to.not.contain(m);
    expect(line).to.contain('reason="a\\u2028\\u2029\\u0085\\u007f\\u200e\\u200f\\u202a\\u202e\\u2066\\u2069\\u061c\\ufeffb"');
    expect(line).to.contain('strategy="x\\u2028authn audit login success"');
  });

  it('leaves out absent fields and survives malformed events', async () => {
    const { sink: s, log } = sink();
    await s.publish({ type: 'logout', outcome: 'success', at: new Date('2026-10-03T10:00:00.000Z') });
    expect(log.lines[0]).to.equal('authn audit logout success at=2026-10-03T10:00:00.000Z');
    await s.publish({ type: 'logout', outcome: 'success', at: new Date(Number.NaN), identity: null } as never);
    expect(log.lines[1]).to.equal('authn audit logout success at=?');
  });

  it('fails on malformed configuration without echoing it', () => {
    let error: unknown;
    try {
      new LogAuthnAuditSink({ hashKey: { secret: 'hunter2' } }, new CapturingLog());
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
    expect((error as Error).message).to.not.contain('hunter2');
  });

  describe('through DI', function () {
    this.timeout(15000);

    let childAudit: unknown = {};

    class SinkTestConfiguration extends FrameworkConfiguration {
      protected onLoad(): unknown {
        return { authn: { audit: { sinks: ['LogAuthnAuditSink'], hashKey: { secret: KEY } } } };
      }
    }

    class ChildAuditConfiguration extends FrameworkConfiguration {
      protected onLoad(): unknown {
        return { authn: { audit: childAudit } };
      }
    }

    let cfg: Configuration;

    useTestLog();

    before(async () => {
      DI.register(SinkTestConfiguration).as(Configuration);
      cfg = await DI.resolve(Configuration);
      expect(cfg).to.be.instanceOf(SinkTestConfiguration);
    });

    beforeEach(() => {
      DI.uncache(AuthnAudit);
      DI.uncache(LogAuthnAuditSink);
    });

    after(() => {
      DI.uncache(AuthnAudit);
      DI.uncache(LogAuthnAuditSink);
      DI.uncache(SinkTestConfiguration);
      DI.unregister(SinkTestConfiguration);
    });

    const auditLines = (): string[] => TestLog.lines.filter((l) => l.includes('authn audit '));

    async function publishInChild(audit: unknown): Promise<void> {
      childAudit = audit;
      const child = DI.RootContainer.child();
      child.register(ChildAuditConfiguration).as(Configuration);
      try {
        expect(await child.resolve(Configuration)).to.be.instanceOf(ChildAuditConfiguration);
        await (await child.resolve(AuthnAudit)).publish(event());
      } finally {
        await child.dispose();
      }
    }

    async function publishInRoot(audit: unknown): Promise<void> {
      cfg.set('authn.audit', audit);
      await (await DI.resolve(AuthnAudit)).publish(event());
    }

    it('is selected by name, resolved as a singleton and writes to the DI Log', async () => {
      const audit = await DI.resolve(AuthnAudit);
      const s = audit.sinks().find((x) => x instanceof LogAuthnAuditSink);
      expect(s).to.equal(await DI.resolve(LogAuthnAuditSink));
      await audit.publish(event());
      expect(auditLines()).to.have.length(1);
      expect(auditLines()[0]).to.match(/^info authn-audit authn audit /);
      expect(auditLines()[0]).to.contain(`ip=${hmac(KEY, `ip|${IP}`)}`);
    });

    it('reads the config of the container that resolves it: hashing on in the root, off in a child', async () => {
      await publishInRoot({ hashKey: { secret: KEY } });
      await publishInChild({ hashIdentifiers: false });
      const [root, child] = auditLines();
      expect(root).to.contain(`ip=${hmac(KEY, `ip|${IP}`)}`);
      expect(child).to.contain(`ip=${IP}`).and.contain('identity=user:u-42');
    });

    it('reads the config of the container that resolves it: hashing off in the root, on in a child', async () => {
      await publishInRoot({ hashIdentifiers: false });
      await publishInChild({ hashKey: { secret: KEY } });
      const [root, child] = auditLines();
      expect(root).to.contain(`ip=${IP}`);
      expect(child).to.not.contain(IP);
      expect(child).to.contain(`ip=${hmac(KEY, `ip|${IP}`)}`);
    });
  });
});

describe('auditLog', () => {
  it('writes through the resolved Log', () => {
    const got: string[] = [];
    const log = auditLog('authn-audit', () => ({ info: (m: string) => got.push(`info ${m}`), warn: (m: string) => got.push(`warn ${m}`) } as never));
    log.info('a');
    log.warn('b');
    expect(got).to.deep.equal(['info a', 'warn b']);
  });

  it('falls back to the console and never throws when no Log is usable', () => {
    const original = console.info;
    const seen: string[] = [];
    console.info = (m: string) => seen.push(m);
    try {
      auditLog('authn-audit', () => undefined).info('fallback');
      auditLog('authn-audit', () => {
        throw new Error('no log');
      }).info('thrown');
      auditLog(
        'authn-audit',
        () =>
          ({
            info: () => {
              throw new Error('broken');
            },
          } as never),
      ).info('broken');
    } finally {
      console.info = original;
    }
    expect(seen).to.deep.equal(['fallback', 'thrown', 'broken']);
  });
});
