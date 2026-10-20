import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import { criticalSection, sleep } from '../src/index.js';

chai.use(chaiAsPromised);

describe('criticalSection', () => {
  it('runs same-name callbacks one at a time and returns their result', async () => {
    let active = 0;
    let max = 0;
    const job = (v: number) => async () => {
      max = Math.max(max, ++active);
      await sleep(10);
      active--;
      return v;
    };

    const res = await Promise.all([criticalSection('a', job(1)), criticalSection('a', job(2)), criticalSection('a', job(3))]);

    expect(res).to.eql([1, 2, 3]);
    expect(max).to.eq(1);
  });

  it('rejects the caller on error and still runs the next callback', async () => {
    const failed = criticalSection('b', async () => {
      throw new Error('boom');
    });
    const next = criticalSection('b', async () => 'ok');

    await expect(failed).to.be.rejectedWith('boom');
    expect(await next).to.eq('ok');
  });
});
