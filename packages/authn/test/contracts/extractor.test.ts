import * as chai from 'chai';
import 'mocha';

import { CredentialExtractor } from '../../src/contracts/extractor.js';
import type { Credentials, SignedRequest } from '../../src/contracts/credentials.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, docOf, same, shapeOf } from './source-shape.js';

const expect = chai.expect;

const bearer = (req: SignedRequest) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
const jwsTyp = (token: string) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).typ;
  } catch {
    return undefined;
  }
};

// The §22.11 list, in its order.
class SignatureExtractor extends CredentialExtractor {
  readonly order = 10;
  extract(req: SignedRequest): Credentials | null {
    return req.headers['signature-input'] && req.headers.signature ? { kind: 'http-signature', request: req } : null;
  }
}
class AssertionExtractor extends CredentialExtractor {
  readonly order = 20;
  extract(req: SignedRequest): Credentials | null {
    const t = bearer(req);
    return t && t.split('.').length === 3 && jwsTyp(t) === 'spinajs-client+jwt' ? { kind: 'jws-assertion', jws: t } : null;
  }
}
class JwtExtractor extends CredentialExtractor {
  readonly order = 30;
  extract(req: SignedRequest): Credentials | null {
    const t = bearer(req);
    return t && t.split('.').length === 3 ? { kind: 'bearer', token: t } : null;
  }
}
class ApiTokenExtractor extends CredentialExtractor {
  readonly order = 40;
  extract(req: SignedRequest): Credentials | null {
    const t = bearer(req);
    return t?.startsWith('spt_') ? { kind: 'bearer', token: t } : null;
  }
}
class ApiKeyHeaderExtractor extends CredentialExtractor {
  readonly order = 50;
  extract(req: SignedRequest): Credentials | null {
    return req.headers['x-api-key'] ? { kind: 'bearer', token: req.headers['x-api-key'] } : null;
  }
}

// What AuthnMiddleware does with them.
const extractors: CredentialExtractor[] = [new ApiKeyHeaderExtractor(), new JwtExtractor(), new SignatureExtractor(), new ApiTokenExtractor(), new AssertionExtractor()];
const first = (req: SignedRequest) => [...extractors].sort((a, b) => a.order - b.order).reduce<Credentials | null>((found, e) => found ?? e.extract(req), null);

const request = (headers: Record<string, string>): SignedRequest => ({ method: 'POST', targetUri: 'https://api.example/files', headers });
const jws = (typ: string) => `${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'k', typ })).toString('base64url')}.e30.sig`;

describe('credential extractor contract', () => {
  describe('runtime', () => {
    it('exports CredentialExtractor from the contracts index as a plain abstract class', () => {
      expect(index.CredentialExtractor).to.eq(CredentialExtractor);
      expect(CredentialExtractor).to.be.a('function');
      expect(Object.getPrototypeOf(CredentialExtractor)).to.eq(Function.prototype);
    });

    it('ordered extractors turn the §22.11 request forms into credentials', () => {
      const assertion = jws('spinajs-client+jwt');
      const jwt = jws('JWT');
      const signed = request({ 'signature-input': 'sig1=()', signature: 'sig1=:AA==:', authorization: `Bearer ${assertion}` });
      expect(first(signed)).to.deep.eq({ kind: 'http-signature', request: signed });
      expect(first(request({ authorization: `Bearer ${assertion}` }))).to.deep.eq({ kind: 'jws-assertion', jws: assertion });
      expect(first(request({ authorization: `Bearer ${jwt}` }))).to.deep.eq({ kind: 'bearer', token: jwt });
      expect(first(request({ authorization: 'Bearer spt_abc' }))).to.deep.eq({ kind: 'bearer', token: 'spt_abc' });
      expect(first(request({ 'x-api-key': 'spt_def' }))).to.deep.eq({ kind: 'bearer', token: 'spt_def' });
      expect(first(request({ cookie: 'ssid=1' }))).to.eq(null);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('extractor.ts holds CredentialExtractor', () => {
      expect(shapeOf(classMembers('extractor.ts'))).to.deep.eq({
        CredentialExtractor: {
          base: null,
          members: [
            { name: 'order', modifiers: ['abstract', 'readonly'], optional: false, params: null },
            { name: 'extract', modifiers: ['abstract'], optional: false, params: ['req'] },
          ],
        },
      });
    });

    it('docs carry the rules a reader needs', () => {
      const c = classMembers('extractor.ts').CredentialExtractor;
      for (const s of ['Array.ofType', 'ascending `order`', 'first non-null', 'Sync', 'after the throttle', 'A05', 'http-signature', 'spinajs-client+jwt', 'spt_', 'x-api-key']) expect(c.doc).to.contain(s);
      expect(docOf(c.members, 'order')).to.contain('Lower');
      for (const s of ['lower case', 'body', 'null']) expect(docOf(c.members, 'extract')).to.contain(s);
    });
  });

  describe('types', () => {
    it('re-exports CredentialExtractor from the contracts index', () => {
      same<index.CredentialExtractor, CredentialExtractor>(true);
    });

    it('members have the planned types', () => {
      same<CredentialExtractor['order'], number>(true);
      same<Parameters<CredentialExtractor['extract']>, [SignedRequest]>(true);
      same<ReturnType<CredentialExtractor['extract']>, Credentials | null>(true);
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const a = () => new CredentialExtractor();
      class AsyncExtractor extends CredentialExtractor {
        readonly order = 1;
        // @ts-expect-error extraction is synchronous: no I/O before the throttle
        async extract(): Promise<Credentials | null> {
          return null;
        }
      }
      // @ts-expect-error order is required
      class Unordered extends CredentialExtractor {
        extract(): Credentials | null {
          return null;
        }
      }
      const e: CredentialExtractor = new ApiTokenExtractor();
      // @ts-expect-error order is readonly
      e.order = 1;
      expect([a, AsyncExtractor, Unordered]).to.have.length(3);
    });
  });
});
