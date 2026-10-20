import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AccessDenied } from '@spinajs/authz';
import { InvalidArgument, MethodNotImplemented } from '@spinajs/exceptions';
import { fsNative } from '@spinajs/fs';
import type { IFsLocalOptions } from '@spinajs/fs';
import { DateTime } from 'luxon';

import { useMiddleware } from './support/mw-setup.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const NOW = new Date('2030-01-01T00:00:00.000Z');
const at = (seconds: number) => DateTime.fromJSDate(NOW).plus({ seconds });

interface Signed {
  readonly path: string;
  readonly until?: DateTime;
  readonly disposition?: string;
}

class SigningFs extends fsNative<IFsLocalOptions> {
  readonly signed: Signed[] = [];

  protected async doSignedUrl(path: string, opts: { until?: DateTime; disposition?: string }): Promise<string> {
    this.signed.push({ path, ...opts });
    return `signed://${this.Name}/${path}?expires=${opts.until?.toMillis() ?? ''}`;
  }
}

const lifetimes = (f: SigningFs): number[] => f.signed.map((x) => x.until!.toMillis() - NOW.getTime());

describe('authz-fs AuthzFsMiddleware: signed URLs (D9)', function () {
  this.timeout(20000);
  const s = useMiddleware(
    {
      'mw-sign': { mode: 'enforce' },
      'mw-def': { mode: 'enforce', signedUrl: { defaultTtlSeconds: 300 } },
      'mw-ttl': { mode: 'enforce', signedUrl: { maxTtlSeconds: 60, defaultTtlSeconds: 300 } },
      'mw-sign-audit': { mode: 'audit', signedUrl: { maxTtlSeconds: 60 } },
    },
    () => ({ now: () => NOW }),
  );
  const signing = (name: string): SigningFs => new SigningFs({ name, basePath: s.base(name, { 'docs/a.txt': 'A' }) });

  it('checks fs:share on the normalised file with its row and signs that path', async () => {
    const f = signing('mw-sign');
    expect(await f.signedUrl('./docs/../docs/a.txt')).to.match(/^signed:\/\/mw-sign\/docs\/a\.txt\?expires=\d+$/);
    expect(s.authz.calls.map((c) => [c.kind, c.permission, c.resource, c.subject])).to.deep.equal([['assert', 'fs:share', 'file:mw-sign:docs/a.txt', { id: 'mw-sign:docs/a.txt', type: 'file', fs: 'mw-sign', path: 'docs/a.txt' }]]);
    expect(f.signed.map((x) => x.path)).to.deep.equal(['docs/a.txt']);
  });

  it('enforce: a denial or a conditional fs:share is AccessDenied and nothing is signed', async () => {
    const f = signing('mw-sign');
    for (const answer of [false, 'conditional'] as const) {
      s.authz.allow = () => answer;
      await expect(f.signedUrl('docs/a.txt'), String(answer)).to.be.rejectedWith(AccessDenied);
    }
    expect(f.signed).to.deep.equal([]);
  });

  it('nothing asked: the URL lives 900 s, or signedUrl.defaultTtlSeconds', async () => {
    const plain = signing('mw-sign');
    const def = signing('mw-def');
    await plain.signedUrl('docs/a.txt');
    await def.signedUrl('docs/a.txt');
    expect([...lifetimes(plain), ...lifetimes(def)]).to.deep.equal([900_000, 300_000]);
  });

  it('until = min(asked or now + defaultTtlSeconds, now + maxTtlSeconds, decision.validUntil)', async () => {
    const f = signing('mw-ttl');
    await f.signedUrl('docs/a.txt', { until: at(30) });
    await f.signedUrl('docs/a.txt', { until: at(3600) });
    await f.signedUrl('docs/a.txt');
    s.authz.validUntil = () => new Date(NOW.getTime() + 10_000);
    await f.signedUrl('docs/a.txt', { until: at(3600) });
    expect(lifetimes(f)).to.deep.equal([30_000, 60_000, 60_000, 10_000]);
  });

  it('an asked until beyond the default stands when no cap applies', async () => {
    const f = signing('mw-def');
    await f.signedUrl('docs/a.txt', { until: at(3600) });
    expect(lifetimes(f)).to.deep.equal([3_600_000]);
  });

  it('signs a copy of the asked DateTime in its zone and leaves the caller options alone', async () => {
    const f = signing('mw-sign');
    const asked = DateTime.fromJSDate(NOW, { zone: 'Europe/Warsaw' }).plus({ seconds: 30 });
    const opts = { until: asked, disposition: 'attachment' };
    await f.signedUrl('docs/a.txt', opts);
    expect(opts.until).to.equal(asked);
    expect(f.signed[0].until).to.not.equal(asked);
    expect(f.signed[0].until!.toMillis()).to.equal(asked.toMillis());
    expect(f.signed[0].until!.zoneName).to.equal('Europe/Warsaw');
    expect(f.signed[0].disposition).to.equal('attachment');
  });

  it('refuses an asked until that is not a valid luxon DateTime, before any check', async () => {
    const f = signing('mw-sign');
    for (const until of [new Date(), 'tomorrow', DateTime.invalid('bad')]) {
      await expect(f.signedUrl('docs/a.txt', { until } as never), String(until)).to.be.rejectedWith(InvalidArgument);
    }
    expect(s.authz.calls).to.deep.equal([]);
    expect(f.signed).to.deep.equal([]);
  });

  it('audit: a denied fs:share warns, signs, and the TTL still narrows', async () => {
    const f = signing('mw-sign-audit');
    s.authz.allow = () => false;
    await f.signedUrl('docs/a.txt', { until: at(3600) });
    expect(lifetimes(f)).to.deep.equal([60_000]);
    expect(s.warnings.some((w) => w.includes('lacks fs:share'))).to.equal(true);
  });

  it('getSignedUrl is checked and narrowed the same way', async () => {
    const f = signing('mw-ttl');
    await f.getSignedUrl('docs/a.txt', at(3600));
    await f.getSignedUrl('docs/a.txt');
    expect(s.authz.keys()).to.deep.equal(['fs:share file:mw-ttl:docs/a.txt', 'fs:share file:mw-ttl:docs/a.txt']);
    expect(lifetimes(f)).to.deep.equal([60_000, 60_000]);
  });

  it('a provider without doSignedUrl answers MethodNotImplemented after the check', async () => {
    await expect(s.local('mw-sign', { 'docs/a.txt': 'A' }).signedUrl('docs/a.txt')).to.be.rejectedWith(MethodNotImplemented);
    expect(s.authz.keys()).to.deep.equal(['fs:share file:mw-sign:docs/a.txt']);
  });
});
