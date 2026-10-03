import * as chai from 'chai';
import 'mocha';

import { ACCESS_DESCRIPTOR, Access, AllowAnonymous, CurrentPrincipal, LinkPrincipalSource, PrincipalSource, Unscoped, fromBody, fromModel, fromParam, fromQuery } from '../src/index.js';
import * as root from '../src/index.js';
import * as api from '../src/api.js';
import type { AccessOptions, ResourceExtractor } from '../src/index.js';
import type { Permission, Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { BasePolicy, Req, Request } from '@spinajs/http';
import type { ModelBase } from '@spinajs/orm';

const expect = chai.expect;

const req = {} as Request;
const model = class Fake {} as unknown as Class<ModelBase>;
const notImplemented = (name: string) => new RegExp(`^@spinajs/authz-http: ${name} is not implemented yet$`);

class FakeSource extends PrincipalSource {
  readonly name = 'fake';
  readonly order = 1;
  async authenticate(_req: Request): Promise<Principal | null> {
    return null;
  }
}

describe('authz-http api', () => {
  it('the stubs not implemented yet throw not implemented', () => {
    expect(() => new LinkPrincipalSource().authenticate(req)).to.throw(Error, notImplemented('LinkPrincipalSource.authenticate'));
  });

  it('the package root exports the implementations in place of the api.ts stubs', () => {
    for (const name of ['Access', 'AllowAnonymous', 'Unscoped', 'fromParam', 'fromBody', 'fromQuery', 'fromModel', 'CurrentPrincipal'] as const) {
      expect(root[name], name).to.be.a('function').and.not.equal(api[name]);
    }
    expect(() => Access('file:read')).to.not.throw();
    expect(() => AllowAnonymous()).to.not.throw();
    expect(() => Unscoped('report export')).to.not.throw();
    expect(() => fromModel(model, 'id')).to.not.throw();
  });

  it('ACCESS_DESCRIPTOR is the registered authz:access symbol', () => {
    expect(ACCESS_DESCRIPTOR).to.equal(Symbol.for('authz:access'));
  });

  it('PrincipalSource takes a minimal fake; LinkPrincipalSource has name and order', async () => {
    expect((root as any).PrincipalSource).to.be.a('function');
    expect(await new FakeSource().authenticate(req)).to.equal(null);
    const link = new LinkPrincipalSource();
    expect(link).to.be.instanceOf(PrincipalSource);
    expect(link.name).to.equal('link');
    expect(link.order).to.equal(110);
  });

  it('AccessOptions accepts every member and no other', () => {
    const extractor: ResourceExtractor = () => ({ type: 'file', id: '1' });
    const asyncExtractor: ResourceExtractor = async () => ({ any: 'model' });
    const none: AccessOptions = {};
    const full: AccessOptions = { resource: extractor, also: [], domain: 'fs', subject: 'none', fields: 'none' };
    // @ts-expect-error subject is 'load' or 'none'
    const bad: AccessOptions = { subject: 'eager' };
    expect([asyncExtractor, none, full, bad]).to.have.length(4);
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

describe('authz-http pinned shapes', () => {
  it('match the design exactly', () => {
    yes<Equal<Shape<PrincipalSource>, { readonly name: string; readonly order: number; authenticate(req: Request): Promise<Principal | null> }>>();
    yes<Equal<LinkPrincipalSource['name'], 'link'>>();
    yes<Equal<LinkPrincipalSource['order'], 110>>();
    yes<Equal<AccessOptions, { resource?: ResourceExtractor; also?: readonly Class<BasePolicy>[]; domain?: string; subject?: 'load' | 'none'; fields?: 'filter' | 'none' }>>();
    yes<Equal<ResourceExtractor, (req: Request) => ResourceRef | object | Promise<ResourceRef | object>>>();
    yes<Equal<typeof Access, (permission: Permission | readonly Permission[], opts?: AccessOptions) => ClassDecorator & MethodDecorator>>();
    yes<Equal<typeof AllowAnonymous, () => ClassDecorator & MethodDecorator>>();
    yes<Equal<typeof Unscoped, (reason: string) => MethodDecorator>>();
    yes<Equal<typeof fromParam, (param: string, type: ResourceType, opts?: { by?: string }) => ResourceExtractor>>();
    yes<Equal<typeof fromBody, (path: string, type: ResourceType) => ResourceExtractor>>();
    yes<Equal<typeof fromQuery, (param: string, type: ResourceType) => ResourceExtractor>>();
    yes<Equal<typeof fromModel, (model: Class<ModelBase>, param: string) => ResourceExtractor>>();
    yes<typeof ACCESS_DESCRIPTOR extends symbol ? (symbol extends typeof ACCESS_DESCRIPTOR ? false : true) : false>();
    yes<Equal<typeof CurrentPrincipal, () => ReturnType<typeof Req>>>();
    expect(true).to.equal(true);
  });
});
