import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

import { ApiKeyHeaderExtractor, AuthorizationBearerExtractor } from '../../src/extractors/bearer.js';
import { HttpSignatureExtractor, publicOriginOf } from '../../src/extractors/signature.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const sreq = (headers: Record<string, string>, over: Partial<SignedRequest> = {}): SignedRequest => ({ method: 'GET', targetUri: '/x', headers, ...over });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwsOf = (typ: string) => `${b64({ alg: 'EdDSA', typ })}.${b64({ iss: 'k' })}.sig`;
const SIGNED = { signature: 'sig=:abc:', 'signature-input': 'sig=("@method");created=1' };

describe('credential extractors through @Config', () => {
  afterEach(disposeBooted);

  describe('schema', () => {
    it('gives the extractors their defaults', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.token.prefix')).to.eq('spt_');
      expect(configuration.get('authn.token.headerName')).to.eq('x-api-key');
      expect(configuration.get('authn.keys.assertion.typ')).to.eq('spinajs-client+jwt');
      expect(configuration.get('authn.http.publicOrigin')).to.eq(undefined);
    });

    it('names a publicOrigin that is not an origin', async function () {
      this.timeout(20000);
      for (const value of ['app.example.com', 'https://app.example.com/app', 'https://user@app.example.com', 'https://*.example.com', 'https://app.example.com?x=1', '', 'null']) {
        expect(await violationsOf(SCHEMAS, { authn: { http: { publicOrigin: value } } }), JSON.stringify(value)).to.include('authn.http.publicOrigin');
      }
      for (const value of ['https://app.example.com', 'http://localhost:3000', 'HTTPS://App.Example.com:443/']) {
        expect(await violationsOf(SCHEMAS, { authn: { http: { publicOrigin: value } } }), value).to.deep.eq([]);
      }
    });

    it('names an empty prefix and header name', async () => {
      expect(await violationsOf(SCHEMAS, { authn: { token: { prefix: '' } } })).to.include('authn.token.prefix');
      expect(await violationsOf(SCHEMAS, { authn: { token: { headerName: '' } } })).to.include('authn.token.headerName');
    });
  });

  describe('AuthorizationBearerExtractor', () => {
    it('reads the default prefix and assertion typ', async () => {
      const { child } = await boot(SCHEMAS, {});
      const e = readingFrom(new AuthorizationBearerExtractor(), child);
      expect(e.extract(sreq({ authorization: 'Bearer spt_a.b.c' }))).to.deep.eq({ kind: 'bearer', token: 'spt_a.b.c' });
      const assertion = jwsOf('spinajs-client+jwt');
      expect(e.extract(sreq({ authorization: `Bearer ${assertion}` }))).to.deep.eq({ kind: 'jws-assertion', jws: assertion });
      expect(e.extract(sreq({ authorization: 'Bearer opaque' }))).to.eq(null);
    });

    it('honours a configured prefix and typ', async () => {
      const { child } = await boot(SCHEMAS, { authn: { token: { prefix: 'tok_' }, keys: { assertion: { typ: 'custom+jwt' } } } });
      const e = readingFrom(new AuthorizationBearerExtractor(), child);
      expect(e.extract(sreq({ authorization: 'Bearer tok_x' }))).to.deep.eq({ kind: 'bearer', token: 'tok_x' });
      expect(e.extract(sreq({ authorization: 'Bearer spt_x' }))).to.eq(null);
      expect(e.extract(sreq({ authorization: `Bearer ${jwsOf('custom+jwt')}` }))?.kind).to.eq('jws-assertion');
      expect(e.extract(sreq({ authorization: `Bearer ${jwsOf('spinajs-client+jwt')}` }))?.kind).to.eq('bearer');
    });

    it('reads the prefix at call time', async () => {
      const { child, configuration } = await boot(SCHEMAS, {});
      const e = readingFrom(new AuthorizationBearerExtractor(), child);
      configuration.set('authn.token.prefix', 'new_');
      expect(e.extract(sreq({ authorization: 'Bearer new_k' }))).to.deep.eq({ kind: 'bearer', token: 'new_k' });
    });
  });

  describe('ApiKeyHeaderExtractor', () => {
    it('reads the default header and prefix, and a configured header name', async () => {
      const def = readingFrom(new ApiKeyHeaderExtractor(), (await boot(SCHEMAS, {})).child);
      expect(def.extract(sreq({ 'x-api-key': 'spt_k' }))).to.deep.eq({ kind: 'bearer', token: 'spt_k' });
      expect(def.extract(sreq({ 'x-api-key': 'other_k' }))).to.eq(null);
      const named = readingFrom(new ApiKeyHeaderExtractor(), (await boot(SCHEMAS, { authn: { token: { headerName: 'X-Token' } } })).child);
      expect(named.extract(sreq({ 'x-token': 'spt_k' }))).to.deep.eq({ kind: 'bearer', token: 'spt_k' });
      expect(named.extract(sreq({ 'x-api-key': 'spt_k' }))).to.eq(null);
    });
  });

  describe('HttpSignatureExtractor', () => {
    const request = (e: HttpSignatureExtractor): Credentials | null => e.extract(sreq(SIGNED));

    it('prefixes the signed target with the normalised public origin', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { publicOrigin: 'HTTPS://App.Example.com:443/' } } });
      expect(request(readingFrom(new HttpSignatureExtractor(), child))).to.deep.include({ kind: 'http-signature' });
      expect((request(readingFrom(new HttpSignatureExtractor(), child)) as { request: { targetUri: string } }).request.targetUri).to.eq('https://app.example.com/x');
    });

    it('gives nothing without a public origin, and honours a later set', async () => {
      const { child, configuration } = await boot(SCHEMAS, {});
      const e = readingFrom(new HttpSignatureExtractor(), child);
      expect(request(e)).to.eq(null);
      configuration.set('authn.http.publicOrigin', 'https://later.example.com');
      expect((request(e) as { request: { targetUri: string } }).request.targetUri).to.eq('https://later.example.com/x');
    });

    it('treats a null publicOrigin as unset: the boot succeeds and a signed request gets no principal', async () => {
      const { child, configuration } = await boot(SCHEMAS, { authn: { http: { publicOrigin: null } } });
      expect(configuration.get('authn.http.publicOrigin')).to.eq(null);
      expect(request(readingFrom(new HttpSignatureExtractor(), child))).to.eq(null);
    });

    it('still refuses an origin the pattern cannot judge', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { publicOrigin: 'https://app.example.com:99999' } } });
      expect(() => request(readingFrom(new HttpSignatureExtractor(), child))).to.throw(InvalidOption, 'authn.http.publicOrigin');
      expect(publicOriginOf(undefined)).to.eq(undefined);
      expect(publicOriginOf(null)).to.eq(undefined);
      expect(publicOriginOf('https://a.example.com/')).to.eq('https://a.example.com');
    });
  });
});
