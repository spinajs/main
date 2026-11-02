import 'mocha';
import { expect } from 'chai';
import type * as express from 'express';

import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { Xml, xmlResponse } from '../src/index.js';
import { memoize, resetXmlBuilder } from '../src/lazy-modules.js';
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
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const XML_BODY = '<user><id>7</id></user>';

describe('xml response', () => {
  let app: TestApp;

  before(async () => {
    app = await createTestApp({ config: {}, bootstrap: false });
  });

  after(() => app.dispose());

  // Earlier suites may have loaded the builder; every test starts from the not-yet-loaded state.
  beforeEach(() => resetXmlBuilder());
  after(() => resetXmlBuilder());

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

  it('hands a failed builder load to req.next', async () => {
    resetXmlBuilder(() => Promise.reject(new Error('EMFILE')));
    const errors: unknown[] = [];
    const sent: ISent = {};
    const failing = { ...req, next: (err: unknown) => errors.push(err) } as unknown as express.Request;

    xmlResponse({ user: { id: 7 } })(failing, fakeResponse(sent));
    await tick();

    expect(errors).to.have.length(1);
    expect((errors[0] as Error).message).to.equal('EMFILE');
    expect(sent).to.deep.equal({});
  });

  it('logs a failed builder load when there is no req.next', async () => {
    resetXmlBuilder(() => Promise.reject(new Error('EMFILE')));
    const logged: unknown[][] = [];
    const log = DI.resolve(Log, ['http']);
    const error = log.error.bind(log);
    log.error = (...args: unknown[]) => logged.push(args);

    try {
      xmlResponse({ user: { id: 7 } })(req, fakeResponse({}));
      await tick();
    } finally {
      log.error = error;
    }

    expect(logged).to.have.length(1);
    expect((logged[0]![0] as { error: Error }).error.message).to.equal('EMFILE');
  });

  it('retries the builder load after a failed one', async () => {
    let calls = 0;
    resetXmlBuilder(() => (++calls === 1 ? Promise.reject(new Error('EMFILE')) : import('fast-xml-parser')));
    const failing = { ...req, next: () => undefined } as unknown as express.Request;
    xmlResponse({ a: 1 })(failing, fakeResponse({}));
    await tick();

    const sent: ISent = {};
    await new Promise<void>((resolve) => xmlResponse({ user: { id: 7 } })(req, fakeResponse(sent, resolve)));

    expect(calls).to.equal(2);
    expect(sent.body).to.equal(XML_BODY);
  });
});

describe('lazy module memoize', () => {
  it('shares one load and retries after a rejection', async () => {
    let calls = 0;
    const load = memoize(() => (++calls === 1 ? Promise.reject(new Error('EMFILE')) : Promise.resolve('ok')));

    const first = load();
    expect(load()).to.equal(first);
    let message = '';
    await first.catch((err: Error) => (message = err.message));
    expect(message).to.equal('EMFILE');

    expect(await load()).to.equal('ok');
    expect(await load()).to.equal('ok');
    expect(calls).to.equal(2);
  });
});
