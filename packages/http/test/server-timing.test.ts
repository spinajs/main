import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { ServerTiming } from '../src/middlewares/ServerTiming.js';
import { Request as sRequest } from '../src/interfaces.js';
import { Ok } from '../src/response-methods/ok.js';

async function run(entries: { name: string; dur?: number; desc?: string }[]): Promise<string> {
  const mw = new ServerTiming();
  const req = { storage: { serverTiming: entries } } as unknown as sRequest;
  const res = { locals: {}, setHeader: sinon.stub() };
  const ctx = { req, res: res as never, storage: req.storage };

  mw.onBefore(ctx);
  await mw.onAfter({ ...ctx, response: new Ok({}) });

  return res.setHeader.firstCall.args[1] as string;
}

describe('ServerTiming middleware', () => {
  it('appends the total entry', async () => {
    expect(await run([])).to.match(/^total;dur=\d+$/);
  });

  it('escapes backslash and double quote in the description quoted-string', async () => {
    const header = await run([{ name: 'db', dur: 1, desc: 'a\\"b' }]);
    expect(header.split(', ')[0]).to.equal('db;dur=1;desc="a\\\\\\"b"');
  });

  it('keeps a trailing backslash from closing the quoted-string early', async () => {
    const header = await run([{ name: 'db', desc: 'x\\' }]);
    expect(header.split(', ')[0]).to.equal('db;desc="x\\\\"');
  });
});
