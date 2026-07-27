import { expect } from 'chai';
import { DateTime } from 'luxon';
import { sessionCookieMaxAge, UserSession } from '../src/index.js';

describe('sessionCookieMaxAge', () => {
  it('derives cookie maxAge (ms) from the session Expiration relative to now (B1)', () => {
    const session = new UserSession();
    session.Expiration = DateTime.now().plus({ minutes: 120 });

    const maxAge = sessionCookieMaxAge(session);

    // ~120 minutes in ms, allow a little slack for execution time
    expect(maxAge).to.be.a('number');
    expect(maxAge!).to.be.greaterThan(119 * 60 * 1000);
    expect(maxAge!).to.be.at.most(120 * 60 * 1000);
  });

  it('returns undefined when the session never expires (no Expiration)', () => {
    const session = new UserSession();
    session.Expiration = undefined;

    expect(sessionCookieMaxAge(session)).to.be.undefined;
  });

  it('clamps to 0 for an already-expired session (never negative)', () => {
    const session = new UserSession();
    session.Expiration = DateTime.now().minus({ minutes: 5 });

    expect(sessionCookieMaxAge(session)).to.equal(0);
  });
});
