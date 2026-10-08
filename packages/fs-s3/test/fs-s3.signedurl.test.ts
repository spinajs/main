import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { IOFail, InvalidOperation } from '@spinajs/exceptions';
import './common.js';
import { fsS3 } from './../src/index.js';
import { S3UrlSigner } from './../src/interfaces.js';

// Runs without S3: the signer and exists() are faked on an instance that is never resolved.
function provider(signer?: Pick<S3UrlSigner, 'sign'>, exists = true) {
  const p = new fsS3({ name: 'unit', bucket: 'unit-bucket' });
  (p as unknown as { Signer?: Pick<S3UrlSigner, 'sign'> }).Signer = signer;
  sinon.stub(p, 'exists').resolves(exists);
  return p;
}

describe('fsS3 signedUrl – unit tests', function () {
  afterEach(() => {
    sinon.restore();
  });

  it('passes until to the signer', async () => {
    const sign = sinon.stub().resolves('https://signed');
    const until = DateTime.now().plus({ minutes: 5 });
    const p = provider({ sign });

    const url = await p.signedUrl('a.txt', { until });

    expect(url).to.equal('https://signed');
    expect(sign.calledOnce).to.be.true;
    expect(sign.firstCall.args[0]).to.equal('a.txt');
    expect(sign.firstCall.args[1]).to.equal(until);
  });

  it('signs with the signer default when until is absent', async () => {
    const sign = sinon.stub().resolves('https://signed');
    const p = provider({ sign });

    await p.signedUrl('a.txt');

    expect(sign.calledOnce).to.be.true;
    expect(sign.firstCall.args[1]).to.be.undefined;
  });

  it('refuses without a signer', async () => {
    const p = provider(undefined);

    await expect(p.signedUrl('a.txt')).to.be.rejectedWith(InvalidOperation, /no signer service configured/);
    expect((p.exists as sinon.SinonStub).called).to.be.false;
  });

  it('refuses a missing file', async () => {
    const sign = sinon.stub().resolves('https://signed');
    const p = provider({ sign }, false);

    await expect(p.signedUrl('missing.txt')).to.be.rejectedWith(IOFail, /does not exists/);
    expect(sign.called).to.be.false;
  });

  it('getSignedUrl delegates to signedUrl with until', async () => {
    const sign = sinon.stub().resolves('https://signed');
    const until = DateTime.now().plus({ minutes: 5 });
    const p = provider({ sign });
    const signedUrl = sinon.spy(p, 'signedUrl');

    expect(await p.getSignedUrl('a.txt', until)).to.equal('https://signed');
    expect(signedUrl.calledOnceWithExactly('a.txt', { until })).to.be.true;
    expect(sign.firstCall.args[1]).to.equal(until);
  });

  it('getSignedUrl without until keeps the signer default', async () => {
    const sign = sinon.stub().resolves('https://signed');
    const p = provider({ sign });

    await p.getSignedUrl('a.txt');

    expect(sign.calledOnce).to.be.true;
    expect(sign.firstCall.args[1]).to.be.undefined;
  });
});
