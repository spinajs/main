import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';

import { Client, loggedIn, seedUser, startApp, stopApp, switchHooksOn, tokenStrategy, tokens, useFakes } from './app.js';

// An array value makes Node write one header line per element.
const lines = (...values: string[]) => values as unknown as string;

async function bearer(): Promise<string> {
  const u = await seedUser();
  const token = `spt_${randomUUID()}`;
  tokens.set(token, u.ref);
  return token;
}

// A problem document: the stable members only, without its status, type, title and instance
const body = (res: { body: unknown }): object => {
  const { code, detail } = res.body as { code?: string; detail?: string };
  return { code, detail };
};

describe('singleton credential headers over HTTP, with the real extractors (RFC 9110 §11.6.2)', function () {
  this.timeout(60000);

  before(async () => {
    useFakes();
    await startApp();
    await switchHooksOn();
  });
  after(stopApp);

  it('a valid bearer sent once authenticates', async () => {
    const res = await new Client().get('/user/sessions', { Authorization: `Bearer ${await bearer()}` });
    expect(res.status, 'a token principal, which this route refuses as session_required').to.eq(403);
    expect((res.body as { error?: string }).error).to.eq('session_required');
  });

  it('answers 400 for Authorization sent twice, even with the same valid token, before any strategy runs', async () => {
    const token = await bearer();
    const before = tokenStrategy.verifyCalls.length;
    const res = await new Client().get('/user/sessions', { Authorization: lines(`Bearer ${token}`, `Bearer ${token}`) });
    expect(res.status).to.eq(400);
    expect(body(res), 'a CodedHttpException body: no stack, the same for every Accept').to.deep.eq({ code: 'E_REPEATED_CREDENTIAL_HEADER', detail: 'the authorization header was sent more than once' });
    expect(tokenStrategy.verifyCalls.length - before).to.eq(0);
  });

  it('answers 400 for a repeated non-prefixed bearer too: it no longer falls through to x-api-key', async () => {
    const res = await new Client().get('/user/sessions', { Authorization: lines('Bearer someone-else', 'Bearer other'), 'x-api-key': await bearer() });
    expect(res.status).to.eq(400);
    expect((res.body as { code?: string }).code).to.eq('E_REPEATED_CREDENTIAL_HEADER');
  });

  it('answers 400 for Proxy-Authorization and the authn.token.headerName header sent twice', async () => {
    const token = await bearer();
    const proxy = await new Client().get('/user/sessions', { 'Proxy-Authorization': lines('Basic a', 'Basic b'), Accept: 'text/html' });
    expect(proxy.status).to.eq(400);
    expect(body(proxy)).to.deep.eq({ code: 'E_REPEATED_CREDENTIAL_HEADER', detail: 'the proxy-authorization header was sent more than once' });
    const res = await new Client().get('/user/sessions', { 'X-Api-Key': lines(token, token) });
    expect(res.status).to.eq(400);
    expect(body(res)).to.deep.eq({ code: 'E_REPEATED_CREDENTIAL_HEADER', detail: 'the x-api-key header was sent more than once' });
  });

  it('leaves a request with an active session alone: the session ignores credential headers', async () => {
    const c = await loggedIn(await seedUser());
    expect((await c.get('/user/sessions', { Authorization: lines('Bearer a', 'Bearer b') })).status).to.eq(200);
  });
});
