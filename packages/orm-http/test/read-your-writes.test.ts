import 'mocha';
import { expect } from 'chai';
import { markWrite, OrmDriver, wroteInScope } from '@spinajs/orm';
import type { IMiddlewareContext, IRouteOutcome } from '@spinajs/http';
import { ReadYourWritesScope } from '../src/read-your-writes.js';

describe('ReadYourWritesScope', () => {
  const primary = {} as OrmDriver;

  function request(scope: ReadYourWritesScope, body: () => void): Promise<void> {
    return scope.onAround({} as IMiddlewareContext, async () => {
      // the rest of the chain runs later than the hook, as the route action does
      await new Promise((resolve) => setImmediate(resolve));
      body();
      return {} as IRouteOutcome;
    });
  }

  it('gives every request its own scope', async () => {
    const scope = new ReadYourWritesScope();
    const seen: boolean[] = [];

    await request(scope, () => {
      markWrite(primary);
      seen.push(wroteInScope(primary));
    });
    await request(scope, () => seen.push(wroteInScope(primary)));

    expect(seen).to.deep.equal([true, false]);
    expect(wroteInScope(primary)).to.eq(false);
  });
});
