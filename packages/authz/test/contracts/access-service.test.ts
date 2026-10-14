import * as chai from 'chai';
import 'mocha';

import * as authz from '../../src/index.js';
import { AccessPushTransport, ChangeAudience } from '../../src/index.js';
import type { AccessChangedEvent, AccessPlan, AuthzChange, AuthzService, Decision, Permission, Principal, ResourceRef, ResourceType } from '../../src/index.js';

const expect = chai.expect;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

const task7: ResourceRef = { type: 'task', id: '7' };

class TagAudience extends ChangeAudience {
  public async audience(change: AuthzChange): Promise<{ readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] }> {
    return change.tags.includes('roles') ? { principals: '*' } : { principals: ['user:alice'], objects: [task7] };
  }
}

class RecordingTransport extends AccessPushTransport {
  public readonly name = 'recording';
  public readonly sent: { principals: readonly string[] | '*'; event: AccessChangedEvent }[] = [];
  public async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    this.sent.push({ principals, event });
  }
}

describe('access service contracts', () => {
  it('exports ChangeAudience and AccessPushTransport as runtime values from the barrel', () => {
    for (const name of ['ChangeAudience', 'AccessPushTransport']) {
      expect((authz as Record<string, unknown>)[name], name).to.be.a('function');
    }
  });

  it('an audience answers principals with exact objects, or every session', async () => {
    const a = new TagAudience();
    expect(await a.audience({ tags: ['subject:user:alice'], at: new Date(0) })).to.deep.equal({ principals: ['user:alice'], objects: [task7] });
    expect(await a.audience({ tags: ['roles'], at: new Date(0) })).to.deep.equal({ principals: '*' });
  });

  it('a transport pushes an event with or without objects', async () => {
    const t = new RecordingTransport();
    await t.push(['user:alice'], { objects: [task7] });
    await t.push('*', {});
    expect(t.name).to.equal('recording');
    expect(t.sent).to.deep.equal([
      { principals: ['user:alice'], event: { objects: [task7] } },
      { principals: '*', event: {} },
    ]);
  });

  it('pins checkAll, accessPlan and the push shapes', () => {
    yes<Equal<Parameters<AuthzService['checkAll']>, [principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]]>>();
    yes<Equal<ReturnType<AuthzService['checkAll']>, Promise<readonly Decision[]>>>();
    yes<Equal<Parameters<AuthzService['accessPlan']>, [principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>]>>();
    yes<Equal<ReturnType<AuthzService['accessPlan']>, Promise<AccessPlan>>>();
    yes<Equal<AccessChangedEvent, { readonly objects?: readonly ResourceRef[] }>>();
    yes<Equal<Shape<ChangeAudience>, { audience(change: AuthzChange): Promise<{ readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] }> }>>();
    yes<Equal<Shape<AccessPushTransport>, { readonly name: string; push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> }>>();
    expect(true).to.equal(true);
  });
});
