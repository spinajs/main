import * as chai from 'chai';
import 'mocha';

import { QueueMessageHook } from '../src/index.js';
import * as root from '../src/index.js';
import type { Initiator, JobOptions } from '../src/index.js';
import type { Ceiling, PrincipalType } from '@spinajs/authz';
import type { IQueueMessage } from '@spinajs/queue';
import { QueueMessageHook as QueuePackageHook } from '@spinajs/queue';

const expect = chai.expect;

class SyncHook extends QueueMessageHook {
  beforeEmit(_message: IQueueMessage): void {}
  aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    return next();
  }
}

class AsyncHook extends QueueMessageHook {
  async beforeEmit(_message: IQueueMessage): Promise<void> {}
  async aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    return await next();
  }
}

describe('authz-queue api', () => {
  it('QueueMessageHook is a runtime export and takes minimal fakes', async () => {
    expect((root as any).QueueMessageHook).to.be.a('function');
    const message = {} as IQueueMessage;
    expect(await new SyncHook().aroundHandle(message, async () => 1)).to.equal(1);
    expect(await new AsyncHook().aroundHandle(message, async () => 'x')).to.equal('x');
  });

  it('QueueMessageHook is the @spinajs/queue class, not a copy', () => {
    expect(QueueMessageHook).to.equal(QueuePackageHook);
    expect(new SyncHook()).to.be.instanceOf(QueuePackageHook);
  });

  it('JobOptions and Initiator accept the design literals', () => {
    const none: JobOptions = {};
    const initiator: JobOptions = { runAs: 'initiator' };
    const system: JobOptions = { runAs: 'system' };
    // @ts-expect-error runAs is 'initiator' or 'system'
    const bad: JobOptions = { runAs: 'user' };
    const user: Initiator = { type: 'user', id: 'u1' };
    const narrowed: Initiator = { type: 'user', id: 'u1', ceiling: { roles: ['viewer'] } };
    // @ts-expect-error Initiator is readonly
    user.id = 'u2';
    expect([none, initiator, system, bad, user, narrowed]).to.have.length(6);
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

describe('authz-queue pinned shapes', () => {
  it('match the design exactly', () => {
    yes<Equal<Shape<QueueMessageHook>, { beforeEmit(message: IQueueMessage): void | Promise<void>; aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> }>>();
    yes<Equal<JobOptions, { runAs?: 'initiator' | 'system' }>>();
    yes<Equal<Initiator, { readonly type: PrincipalType; readonly id: string; readonly ceiling?: Ceiling }>>();
    expect(true).to.equal(true);
  });
});
