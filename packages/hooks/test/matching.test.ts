import * as chai from 'chai';
import 'mocha';

import { ActionHook } from '../src/index.js';
import type { ActionName, ActionPattern } from '../src/index.js';
import { matches } from '../src/match.js';
import { addHook, boot, disposeChildren, useTestLog } from './support.js';

const expect = chai.expect;

type Empty = { input: Record<string, never>; output: void };

declare module '@spinajs/hooks' {
  interface HookActions {
    authn: Empty;
    'authn.login': Empty;
    'authn.login.identified': Empty;
    'authn.password.change': Empty;
    'authnx.login': Empty;
    'users.create': Empty;
  }
}

const ACTIONS: ActionName[] = ['authn', 'authn.login', 'authn.login.identified', 'authn.password.change', 'authnx.login', 'users.create'];

/** For each pattern, the actions of ACTIONS it matches. */
const TABLE: [ActionPattern, ActionName[]][] = [
  ['*', ACTIONS],
  ['authn.*', ['authn.login', 'authn.login.identified', 'authn.password.change']],
  ['authn.password.*', ['authn.password.change']],
  ['authn.login', ['authn.login']],
  ['authn', ['authn']],
];

class Patterned extends ActionHook {
  constructor(readonly actions: readonly ActionPattern[]) {
    super();
  }
}

describe('action patterns', function () {
  this.timeout(10000);
  useTestLog();

  afterEach(disposeChildren);

  describe('matches', () => {
    for (const [pattern, matched] of TABLE) {
      it(`'${pattern}' matches ${matched.join(', ')} and no other action`, () => {
        expect(ACTIONS.filter((a) => matches(pattern, a))).to.deep.eq(matched);
      });
    }
  });

  describe('Hooks.has', () => {
    it('is false for every action when no hook is registered', async () => {
      const { hooks } = await boot();
      for (const a of ACTIONS) expect(hooks.has(a), a).to.be.false;
    });

    for (const [pattern, matched] of TABLE) {
      it(`with one hook on '${pattern}', is true only for ${matched.join(', ')}`, async () => {
        const { hooks } = await boot({}, (c) => addHook(c, new Patterned([pattern])));
        expect(ACTIONS.filter((a) => hooks.has(a))).to.deep.eq(matched);
      });
    }

    it('is true for an action that any pattern of a hook matches', async () => {
      const { hooks } = await boot({}, (c) => addHook(c, new Patterned(['authn.password.*', 'users.create'])));
      expect(ACTIONS.filter((a) => hooks.has(a))).to.deep.eq(['authn.password.change', 'users.create']);
    });
  });
});
