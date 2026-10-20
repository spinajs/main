import assert from 'node:assert/strict';
import 'mocha';
import { EnrolledMfaPolicy, FakeMfaStep } from '../../src/fakes/index.js';

const A = { type: 'user', id: 'a' };
const B = { type: 'user', id: 'b' };

describe('FakeMfaStep', () => {
  it('names the step and refuses the name recovery', () => {
    assert.equal(new FakeMfaStep().name, 'fake');
    assert.equal(new FakeMfaStep({ name: 'totp' }).name, 'totp');
    assert.throws(() => new FakeMfaStep({ name: 'recovery' }));
  });

  it('accepts a scripted code once and only for an enrolled identity', async () => {
    const s = new FakeMfaStep();
    const early = s.nextCode(A);
    assert.equal(await s.verify(A, early), false);
    s.enrol(A);
    assert.equal(await s.enrolled(A), true);
    assert.equal(await s.verify(A, early), true);
    assert.equal(await s.verify(A, early), false);
    const code = s.nextCode(A);
    assert.equal(await s.verify(B, code), false);
    assert.equal(await s.verify(A, '000000x'), false);
    assert.deepEqual(
      s.verifyCalls.map((c) => c.response),
      [early, early, early, code, '000000x'],
    );
  });

  it('enrols through begin and confirm and returns recovery codes', async () => {
    const s = new FakeMfaStep({ recoveryCodes: 3 });
    const { provisioning } = await s.beginEnrolment(A);
    const code = new URL(provisioning).searchParams.get('code')!;
    assert.match(provisioning, /^fake:\/\/enrol\?code=\d{6}$/);
    assert.deepEqual(await s.confirmEnrolment(A, 'wrong'), {});
    assert.equal(await s.enrolled(A), false);
    const res = await s.confirmEnrolment(A, code);
    assert.equal(res.recoveryCodes?.length, 3);
    assert.equal(await s.enrolled(A), true);
    assert.deepEqual(await s.confirmEnrolment(A, code), {});
  });

  it('verify never takes a recovery code; recovery codes are single use', async () => {
    const s = new FakeMfaStep();
    s.enrol(A);
    const codes = await s.regenerateRecoveryCodes!(A);
    assert.equal(codes.length, 10);
    assert.equal(await s.verify(A, codes[0]), false);
    assert.equal(await s.verifyRecovery!(A, codes[0]), true);
    assert.equal(await s.verifyRecovery!(A, codes[0]), false);
    assert.equal(await s.verifyRecovery!(B, codes[1]), false);
  });

  it('regenerating voids the old recovery codes', async () => {
    const s = new FakeMfaStep({ recoveryCodes: 2 });
    s.enrol(A);
    const old = await s.regenerateRecoveryCodes!(A);
    const fresh = await s.regenerateRecoveryCodes!(A);
    assert.equal(await s.verifyRecovery!(A, old[0]), false);
    assert.equal(await s.verifyRecovery!(A, fresh[0]), true);
  });

  it('recoveryCodes false leaves the optional members undefined', async () => {
    const s = new FakeMfaStep({ recoveryCodes: false });
    assert.equal(typeof s.verifyRecovery, 'undefined');
    assert.equal(typeof s.regenerateRecoveryCodes, 'undefined');
    assert.equal(Object.prototype.hasOwnProperty.call(s, 'verifyRecovery'), false);
    const { provisioning } = await s.beginEnrolment(A);
    assert.deepEqual(await s.confirmEnrolment(A, new URL(provisioning).searchParams.get('code')!), {});
  });

  it('disable clears enrolment, codes and recovery codes', async () => {
    const s = new FakeMfaStep();
    s.enrol(A);
    const code = s.nextCode(A);
    const [rec] = await s.regenerateRecoveryCodes!(A);
    await s.disable(A);
    assert.equal(await s.enrolled(A), false);
    s.enrol(A);
    assert.equal(await s.verify(A, code), false);
    assert.equal(await s.verifyRecovery!(A, rec), false);
  });
});

describe('EnrolledMfaPolicy', () => {
  it('requires the enrolled steps for the configured methods only', async () => {
    const totp = new FakeMfaStep({ name: 'totp' });
    const mail = new FakeMfaStep({ name: 'mail' });
    const policy = new EnrolledMfaPolicy([totp, mail]);
    assert.deepEqual(await policy.required(A, { method: 'password', strategy: 'local' }), []);
    totp.enrol(A);
    assert.deepEqual(await policy.required(A, { method: 'password', strategy: 'local' }), ['totp']);
    mail.enrol(A);
    assert.deepEqual(await policy.required(A, { method: 'password', strategy: 'local' }), ['totp', 'mail']);
    assert.deepEqual(await policy.required(A, { method: 'oidc', strategy: 'x' }), []);
    assert.deepEqual(await new EnrolledMfaPolicy([totp], { methods: ['oidc'] }).required(A, { method: 'oidc', strategy: 'x' }), ['totp']);
  });
});
