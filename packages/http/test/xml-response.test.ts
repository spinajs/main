import 'mocha';
import { expect } from 'chai';
import type * as express from 'express';

import { Xml, xmlResponse } from '../src/index.js';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

interface ISent {
  status?: number;
  contentType?: unknown;
  body?: unknown;
}

function fakeResponse(sent: ISent, onSend: () => void = () => undefined): express.Response {
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    setHeader() {},
    set(name: string, value: unknown) {
      if (name === 'Content-Type') sent.contentType = value;
      return res;
    },
    cookie() {},
    send(body?: unknown) {
      sent.body = body;
      onSend();
    },
  };
  return res as unknown as express.Response;
}

const req = { headers: {}, accepts: (offered: string[]) => offered[0] } as unknown as express.Request;
const XML_BODY = '<user><id>7</id></user>';

describe('xml response', () => {
  let app: TestApp;

  before(async () => {
    app = await createTestApp({ config: {}, bootstrap: false });
  });

  after(() => app.dispose());

  // First in the file: in a run of this file alone the XML builder is not loaded yet.
  it('sends the body when its response function is called directly', async () => {
    const sent: ISent = {};
    await new Promise<void>((resolve) => xmlResponse({ user: { id: 7 } })(req, fakeResponse(sent, resolve)));

    expect(sent).to.deep.equal({ status: 200, contentType: 'application/xml', body: XML_BODY });
  });

  it('sends the body synchronously from the function its execute returns', async () => {
    const sent: ISent = {};
    const res = fakeResponse(sent);
    const fn = await new Xml({ user: { id: 7 } }).execute(req, res);
    if (fn) fn(req, res);

    expect(sent).to.deep.equal({ status: 200, contentType: 'application/xml', body: XML_BODY });
  });
});
