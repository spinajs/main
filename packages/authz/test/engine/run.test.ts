import * as chai from 'chai';
import 'mocha';

import { settleWithin } from '../../src/engine/run.js';
import { describeError } from '../../src/engine/vote.js';

const expect = chai.expect;

describe('engine/run: settleWithin', () => {
  it('names the hook the caller gives in every failure', async () => {
    expect(await settleWithin(Promise.reject(new Error('down')), 1000, describeError, 'summarize')).to.deep.equal({ ok: false, error: 'summarize rejected: Error: down' });
    const broken = {
      then(): never {
        throw new Error('bad then');
      },
    };
    expect(await settleWithin(broken, 1000, describeError, 'preload')).to.deep.equal({ ok: false, error: 'preload returned a broken thenable: Error: bad then' });
    expect(await settleWithin(new Promise(() => undefined), 10, describeError, 'subject evaluation')).to.deep.equal({ ok: false, error: 'subject evaluation timed out after 10 ms' });
  });

  it('passes the value through', async () => {
    expect(await settleWithin(Promise.resolve(7), 1000, describeError, 'evaluate')).to.deep.equal({ ok: true, value: 7 });
  });
});
