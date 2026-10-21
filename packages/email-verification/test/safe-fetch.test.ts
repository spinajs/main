import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidArgument } from '@spinajs/exceptions';
import { ResponseTooLarge, SafeFetch } from '../src/safe-fetch.js';
import { stubFetch, text } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('SafeFetch', () => {
  const http = new SafeFetch();
  let stub: ReturnType<typeof stubFetch> | undefined;
  afterEach(() => stub?.restore());

  it('refuses a URL that is not https without fetching', async () => {
    stub = stubFetch(() => text(200, 'x'));
    const err = await http.get('http://example.com/x?key=SECRET', { timeoutMs: 100, maxBytes: 10 }).catch((e) => e);
    expect(err.message).to.contain('only https').and.not.contain('SECRET');
    expect(stub.calls).to.have.length(0);
  });

  it('sends manual redirects, the headers and a timeout signal', async () => {
    stub = stubFetch(() => text(200, 'ok'));
    const res = await http.get('https://example.com/x', { timeoutMs: 100, maxBytes: 10, headers: { accept: 'text/plain' } });
    expect(res.status).to.eq(200);
    expect(res.body).to.eq('ok');
    expect(stub.calls[0].init.redirect).to.eq('manual');
    expect(stub.calls[0].init.headers).to.deep.eq({ accept: 'text/plain' });
    expect(stub.calls[0].init.signal).to.be.instanceOf(AbortSignal);
  });

  it('returns a redirect as is', async () => {
    stub = stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    expect((await http.get('https://example.com/x', { timeoutMs: 100, maxBytes: 10 })).status).to.eq(302);
    expect(stub.calls).to.have.length(1);
  });

  it('throws ResponseTooLarge past maxBytes', async () => {
    stub = stubFetch(() => text(200, 'x'.repeat(11)));
    const err = await http.get('https://example.com/x?key=SECRET', { timeoutMs: 100, maxBytes: 10 }).catch((e) => e);
    expect(err).to.be.instanceOf(ResponseTooLarge);
    expect(err.message).to.not.contain('SECRET');
  });

  it('refuses a malformed URL without leaking it', async () => {
    stub = stubFetch(() => text(200, 'x'));
    const err = await http.get('https://exa mple.com/x?key=SECRET', { timeoutMs: 100, maxBytes: 10 }).catch((e) => e);
    expect(err).to.be.instanceOf(InvalidArgument);
    expect(err.message).to.not.contain('SECRET');
    expect(JSON.stringify(err)).to.not.contain('SECRET');
    expect(stub.calls).to.have.length(0);
  });

  it('accepts a body of exactly maxBytes', async () => {
    stub = stubFetch(() => text(200, 'x'.repeat(10)));
    expect((await http.get('https://example.com/x', { timeoutMs: 100, maxBytes: 10 })).body).to.have.length(10);
  });

  it('rejects a multi-chunk body crossing the cap and cancels the stream', async () => {
    let cancelled = false;
    let i = 0;
    stub = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              if (i++ < 5) c.enqueue(new TextEncoder().encode('xxxx'));
              else c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    await expect(http.get('https://example.com/x', { timeoutMs: 100, maxBytes: 10 })).to.be.rejectedWith(ResponseTooLarge);
    expect(cancelled).to.eq(true);
  });

  it('keeps ResponseTooLarge when cancel rejects', async () => {
    stub = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new TextEncoder().encode('x'.repeat(11)));
            },
            cancel() {
              throw new Error('cancel failed');
            },
          }),
        ),
    );
    await expect(http.get('https://example.com/x', { timeoutMs: 100, maxBytes: 10 })).to.be.rejectedWith(ResponseTooLarge);
  });

  it('aborts after timeoutMs', async () => {
    stub = stubFetch((_, init) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    await expect(http.get('https://example.com/x', { timeoutMs: 20, maxBytes: 10 })).to.be.rejected.and.eventually.have.property('name', 'TimeoutError');
  });
});
