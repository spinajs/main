import 'mocha';
import { expect } from 'chai';

import { Forbidden } from '@spinajs/exceptions';
import { extractorType } from '@spinajs/authz-http';

import { ownUser } from '../../src/services/own-user.js';

const UUID = '6f0a2f3c-7d1e-4a55-9c2b-0a1b2c3d4e5f';

const requestOf = (principal: object | undefined): any => ({ storage: { Principal: principal } });

describe('users-http v3: ownUser extractor', () => {
  it('declares the user type', () => {
    expect(extractorType(ownUser)).to.eq('user');
  });

  it('answers the user ref of a user principal', async () => {
    expect(await ownUser(requestOf({ type: 'user', id: UUID, authenticated: true }))).to.deep.eq({ type: 'user', id: UUID });
  });

  for (const type of ['service', 'agent', 'token']) {
    it(`refuses a ${type} principal, even when its id is a user's Uuid`, async () => {
      let refused: unknown;
      try {
        await ownUser(requestOf({ type, id: UUID, authenticated: true }));
      } catch (e) {
        refused = e;
      }
      expect(refused).to.be.instanceOf(Forbidden);
    });
  }

  for (const [what, principal] of [
    ['no principal', undefined],
    ['an empty id', { type: 'user', id: '' }],
    ['a numeric id', { type: 'user', id: 7 }],
  ] as const) {
    it(`refuses ${what}`, async () => {
      let refused: unknown;
      try {
        await ownUser(requestOf(principal));
      } catch (e) {
        refused = e;
      }
      expect(refused).to.be.instanceOf(Forbidden);
    });
  }
});
