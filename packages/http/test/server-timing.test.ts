import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { ServerTiming } from '../src/middlewares/ServerTiming.js';
import { Request as sRequest } from '../src/interfaces.js';

function run(entries: { name: string; dur?: number; desc?: string }[]): string {
  const mw = new ServerTiming();
  Object.defineProperty(mw, 'Enabled', { value: true });
  const req = { storage: { serverTiming: entries } } as unknown as sRequest;
  const res = { headersSent: false, setHeader: sinon.stub(), end: sinon.stub() };

  mw.before()!(req, res as any, sinon.spy());
  res.end();

  return res.setHeader.firstCall.args[1] as string;
}

describe('ServerTiming middleware', () => {
  it('appends the total entry', () => {
    expect(run([])).to.match(/^total;dur=\d+$/);
  });

  it('escapes backslash and double quote in the description quoted-string', () => {
    const header = run([{ name: 'db', dur: 1, desc: 'a\\"b' }]);
    expect(header.split(', ')[0]).to.equal('db;dur=1;desc="a\\\\\\"b"');
  });

  it('keeps a trailing backslash from closing the quoted-string early', () => {
    const header = run([{ name: 'db', desc: 'x\\' }]);
    expect(header.split(', ')[0]).to.equal('db;desc="x\\\\"');
  });
});
