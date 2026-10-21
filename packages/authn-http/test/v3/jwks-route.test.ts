import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { JwsSigner } from '@spinajs/authn/contracts';
import type { JwsKey, KeyAlgorithm } from '@spinajs/authn/contracts';
import { generateKeyPair } from '@spinajs/authn-testing';

import { TestConfiguration, req, restoreHttpErrorMap, startHttpServer } from '../token-common.js';

class JwksRouteConfiguration extends TestConfiguration {}

const JWKS_PATH = '.well-known/jwks.json';
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];
const PRIVATE_VALUE = 'private-member-value';

// Same as releaseHttpServer() of packages/http/test/common.ts, which imports http's sources and so cannot be shared.
async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type);
  DI.uncache(BaseController);
}

interface Answer {
  status: number;
  text: string;
  headers: Record<string, string>;
  body: { error?: string; keys: Record<string, unknown>[] };
}

async function get(accept?: string): Promise<Answer> {
  const call = req().get(JWKS_PATH);
  const res = await (accept === undefined ? call : call.set('Accept', accept));
  return { status: res.status, text: res.text, headers: res.header as Record<string, string>, body: res.body as Answer['body'] };
}

// A key whose jwk also carries private members, as a careless signer could hand over: the route must drop them.
function leakyKey(alg: KeyAlgorithm, kid: string): JwsKey {
  const pair = generateKeyPair(alg);
  return { alg, kid, jwk: { ...pair.publicJwk, d: PRIVATE_VALUE, p: PRIVATE_VALUE, k: PRIVATE_VALUE } } as unknown as JwsKey;
}

// Not the authn-keys signer: importing that package registers its models, whose tables this package's tests do not create.
class StubJwsSigner extends JwsSigner {
  constructor(private readonly keys: readonly JwsKey[]) {
    super();
  }

  public sign(): Promise<string> {
    return Promise.reject(new Error('the JWKS route never signs'));
  }

  public publicKeys(): Promise<readonly JwsKey[]> {
    return Promise.resolve(this.keys);
  }
}

describe('GET /.well-known/jwks.json', function () {
  this.timeout(30000);

  const keys = [leakyKey('EdDSA', 'k1'), leakyKey('ES256', 'k2')];

  before(async () => {
    DI.setESMModuleSupport();
    restoreHttpErrorMap();

    DI.unregister(JwksRouteConfiguration);
    DI.register(JwksRouteConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);
    await startHttpServer();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(JwksRouteConfiguration);
    DI.uncache(JwksRouteConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
  });

  describe('without a JwsSigner', () => {
    it('answers 404 not_found, also to an anonymous caller', async () => {
      const res = await get('application/json');
      expect(res.status).to.eq(404);
      expect(res.body.error).to.eq('not_found');
    });
  });

  describe('with a JwsSigner', () => {
    before(() => {
      const signer = new StubJwsSigner(keys);
      DI.register({ JwksRouteSigner: () => signer }.JwksRouteSigner).as(JwsSigner);
    });

    it('answers 200 with the JWK Set media type and a five minute public cache', async () => {
      const res = await get();
      expect(res.status, res.text).to.eq(200);
      expect(res.headers['content-type']).to.eq('application/jwk-set+json');
      expect(res.headers['cache-control']).to.eq('public, max-age=300');
    });

    it('answers a client that accepts only the JWK Set type', async () => {
      const res = await get('application/jwk-set+json');
      expect(res.status).to.eq(200);
      expect(res.body.keys).to.have.length(2);
    });

    it('lists every public key of the signer as { keys: [...] }', async () => {
      const res = await get();
      const set = res.body;
      expect(Object.keys(set)).to.deep.eq(['keys']);
      expect(set.keys.map((k) => k.kid)).to.have.members(['k1', 'k2']);

      const byKid = new Map(set.keys.map((k) => [k.kid as string, k]));
      expect(byKid.get('k1')).to.deep.include({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', x: keys[0].jwk.x });
      expect(byKid.get('k2')).to.deep.include({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', x: keys[1].jwk.x, y: (keys[1].jwk as { y: string }).y });
    });

    it('never carries a private member or the private value', async () => {
      const res = await get();
      for (const key of res.body.keys) {
        for (const member of PRIVATE_MEMBERS) expect(key, `${key.kid as string}.${member}`).to.not.have.property(member);
      }
      expect(res.text).to.not.contain(PRIVATE_VALUE);
    });
  });
});
