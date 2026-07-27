import { expect } from 'chai';
import { DateTime } from 'luxon';
import { encodeSessionData, decodeSessionData } from '../src/index.js';

describe('Session data codec (encodeSessionData / decodeSessionData)', () => {
  it('round-trips primitive value types (string, number, boolean, null)', () => {
    const data = new Map<string, unknown>([
      ['User', 'a-uuid'],
      ['count', 7],
      ['Authorized', true],
      ['nothing', null],
    ]);

    const restored = decodeSessionData(encodeSessionData(data));

    expect(restored).to.be.instanceOf(Map);
    expect(restored.get('User')).to.equal('a-uuid');
    expect(restored.get('count')).to.equal(7);
    expect(restored.get('Authorized')).to.equal(true);
    expect(restored.get('nothing')).to.equal(null);
  });

  it('round-trips a DateTime value as a DateTime (symmetric replacer/reviver — B5)', () => {
    const when = DateTime.fromISO('2026-03-04T05:06:07.000Z');
    const data = new Map<string, unknown>([['when', when]]);

    const restored = decodeSessionData(encodeSessionData(data));

    const got = restored.get('when');
    expect(DateTime.isDateTime(got), 'value should decode back to a DateTime').to.be.true;
    expect((got as DateTime).toMillis()).to.equal(when.toMillis());
  });

  it('round-trips nested Map and Set values', () => {
    const data = new Map<string, unknown>([
      ['roles', new Set(['admin', 'user'])],
      ['meta', new Map<string, unknown>([['k', 'v']])],
    ]);

    const restored = decodeSessionData(encodeSessionData(data));

    const roles = restored.get('roles') as Set<string>;
    const meta = restored.get('meta') as Map<string, unknown>;
    expect(roles).to.be.instanceOf(Set);
    expect([...roles].sort()).to.deep.equal(['admin', 'user']);
    expect(meta).to.be.instanceOf(Map);
    expect(meta.get('k')).to.equal('v');
  });

  it('decodes an empty map', () => {
    const restored = decodeSessionData(encodeSessionData(new Map()));
    expect(restored).to.be.instanceOf(Map);
    expect(restored.size).to.equal(0);
  });
});
