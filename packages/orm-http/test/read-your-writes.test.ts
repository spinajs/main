import 'mocha';
import { expect } from 'chai';
import { markWrite, OrmDriver, wroteInScope } from '@spinajs/orm';
import { ReadYourWritesScope } from '../src/read-your-writes.js';

describe('ReadYourWritesScope', () => {
  const primary = {} as OrmDriver;

  function request(handler: ReturnType<ReadYourWritesScope['before']>, body: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      handler({} as never, {} as never, () => {
        body();
        setImmediate(resolve);
      });
    });
  }

  it('gives every request its own scope', async () => {
    const handler = new ReadYourWritesScope().before();
    const seen: boolean[] = [];

    await request(handler, () => {
      markWrite(primary);
      seen.push(wroteInScope(primary));
    });
    await request(handler, () => seen.push(wroteInScope(primary)));

    expect(seen).to.deep.equal([true, false]);
    expect(wroteInScope(primary)).to.eq(false);
  });
});
