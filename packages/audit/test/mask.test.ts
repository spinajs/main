import * as chai from 'chai';
import 'mocha';
import { AuditConfigError, MASKED, auditHash, trailConfig } from '../src/index.js';
import type { AuditEvent } from '../src/index.js';
import { maskOf } from '../src/mask.js';

const expect = chai.expect;

const event = (data: Record<string, unknown>): AuditEvent => ({ id: 'e1', at: new Date(0), kind: 'action', action: 'pay', outcome: 'ok', actor: 'user:u1', origin: '10.0.0.7', data });

describe('audit masking', () => {
  const trail = trailConfig();

  it('omits, masks and hashes dot paths and leaves the input alone', () => {
    const input = event({ args: { card: '4111', pin: '1234', email: 'a@b.c', note: 'x' } });
    const out = maskOf(trail, { omit: ['data.args.pin'], mask: ['data.args.card'], hash: ['data.args.email'] })(input);
    expect(out.data).to.deep.eq({ args: { card: MASKED, email: auditHash('a@b.c'), note: 'x' } });
    expect(input.data).to.deep.eq({ args: { card: '4111', pin: '1234', email: 'a@b.c', note: 'x' } });
  });

  it('matches one segment with a star, also over a list', () => {
    const out = maskOf(trail, { mask: ['data.rows.*.ssn', 'data.*.secret'] })(
      event({
        rows: [
          { ssn: '1', n: 1 },
          { ssn: '2', n: 2 },
        ],
        a: { secret: 's' },
        b: { secret: 't', kept: true },
      }),
    );
    expect(out.data).to.deep.eq({
      rows: [
        { ssn: MASKED, n: 1 },
        { ssn: MASKED, n: 2 },
      ],
      a: { secret: MASKED },
      b: { secret: MASKED, kept: true },
    });
  });

  it('hashes the fields outside the payload and keeps dates', () => {
    const when = new Date('2026-11-16T10:00:00.000Z');
    const out = maskOf(trail, { hash: ['actor', 'origin', 'onBehalfOf'], omit: ['dataSubject'] })({ ...event({ when }), dataSubject: 'person:7' });
    expect(out.actor).to.eq(auditHash('user:u1'));
    expect(out.origin).to.eq(auditHash('10.0.0.7'));
    expect(out.origin).to.have.length(43);
    expect(out.onBehalfOf).to.eq(undefined);
    expect('dataSubject' in out).to.eq(false);
    expect(out.data.when).to.eq(when);
    expect(out.at).to.be.instanceOf(Date);
  });

  it("adds the trail's own lists", () => {
    const security = trailConfig('security');
    const out = maskOf(security, { mask: ['data.reason'] })(event({ identity: 'alice', reason: 'bad password' }));
    expect(out.data).to.deep.eq({ identity: auditHash('alice'), reason: MASKED });
    expect(out.actor).to.eq(auditHash('user:u1'));
  });

  it('applies a path once when the trail and the call both name it', () => {
    const out = maskOf(trailConfig('security'), { hash: ['data.identity', 'actor'] })(event({ identity: 'alice' }));
    expect(out.data).to.deep.eq({ identity: auditHash('alice') });
    expect(out.actor).to.eq(auditHash('user:u1'));
  });

  it('masks, omits and hashes through class instances and keeps binary leaves', () => {
    class Login {
      [field: string]: unknown;
      constructor(
        readonly user: string,
        readonly password: string,
        readonly pin: string,
        readonly email: string,
      ) {}
    }
    const blob = Buffer.from('x');
    const out = maskOf(trail, { mask: ['data.args.password', 'data.blob.x'], omit: ['data.args.pin'], hash: ['data.args.email'] })(event({ args: new Login('a', 'p', '1', 'a@b.c'), blob }));
    expect(out.data).to.deep.eq({ args: { user: 'a', password: MASKED, email: auditHash('a@b.c') }, blob });

    const own = maskOf(trail, { mask: ['data.password'] })({ ...event({}), data: new Login('a', 'p', '1', 'a@b.c') });
    expect(own.data).to.deep.eq({ user: 'a', password: MASKED, pin: '1', email: 'a@b.c' });
  });

  it('hashes a value that is not a string as its canonical JSON', () => {
    const out = maskOf(trail, { hash: ['data.*'] })(event({ a: { y: 1, x: 2 }, b: { x: 2, y: 1 }, n: 7, s: '7', big: 7n }));
    expect(out.data.a).to.eq(auditHash('{"x":2,"y":1}'));
    expect(out.data.b).to.eq(out.data.a);
    // One identifier written as a number in one place and as text in another stays correlatable.
    expect([out.data.n, out.data.big]).to.deep.eq([auditHash('7'), auditHash('7')]);
    expect(out.data.s).to.eq(auditHash('7'));

    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => maskOf(trail, { hash: ['data.loop'] })(event({ loop }))).to.throw(AuditConfigError, 'audit: hash path "data.loop" reached a value that cannot be written as JSON');
  });

  it('refuses a path that would break the event', () => {
    expect(() => maskOf(trail, { omit: ['actor'] })).to.throw(AuditConfigError, 'audit: a write to trail "default": omit path "actor" is not maskable');
    expect(() => maskOf(trail, { mask: ['data'] })).to.throw(AuditConfigError, 'mask path "data" is not maskable');
    expect(() => maskOf(trail, { hash: ['data.__proto__.x'] })).to.throw(AuditConfigError, 'is not maskable');
  });
});
