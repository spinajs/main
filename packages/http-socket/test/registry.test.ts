import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnConnect, OnDisconnect, OnEvent, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { MAX_NAME_LENGTH } from '@spinajs/http-socket-common';
import { configure } from './harness.js';

export class RegAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@SocketController('reg')
@SocketPolicy(RegAllow)
export class RegistrySocket extends BaseSocketController {
  @Command('add')
  public async add(@Payload() n: number) {
    return n + 1;
  }

  @OnEvent('ping')
  public async ping(): Promise<void> {}

  @OnConnect()
  public async hello(): Promise<void> {}

  @OnDisconnect()
  public async bye(): Promise<void> {}
}

export class RegDupOne extends BaseSocketController {
  @Command('reg-dup.same')
  public async one(): Promise<void> {}
}

export class RegDupTwo extends BaseSocketController {
  @Command('reg-dup.same')
  public async two(): Promise<void> {}
}

export class RegOrphan extends BaseSocketController {
  public async orphan(@Payload() _payload: unknown): Promise<void> {}
}

export class RegBadName extends BaseSocketController {
  @OnEvent('reg-name.has space')
  public async spaced(): Promise<void> {}
}

export class RegLongName extends BaseSocketController {
  @Command('reg-long.' + 'x'.repeat(MAX_NAME_LENGTH))
  public async long(): Promise<void> {}
}

describe('socket handler registry', function () {
  this.timeout(15000);

  let registry: SocketHandlerRegistry;

  beforeEach(async () => {
    await configure();
    registry = DI.resolve(SocketHandlerRegistry);
    await registry.build();
  });

  it('registers commands under the controller prefix', () => {
    const handler = registry.command('reg.add')!;
    expect(handler.fullName).to.equal('reg.add');
    expect(handler.controller).to.be.instanceOf(RegistrySocket);
    expect(registry.command('add')).to.be.undefined;
  });

  it('resolves the policies once, at registration', () => {
    const handler = registry.command('reg.add')!;
    expect(handler.policies.Controller).to.have.length(1);
    expect(handler.policies.Controller[0][0]).to.be.instanceOf(RegAllow);
    expect(handler.policies.Route).to.deep.equal([]);
  });

  it('keeps events apart from commands', () => {
    expect(registry.event('reg.ping')).to.exist;
    expect(registry.command('reg.ping')).to.be.undefined;
  });

  it('collects lifecycle hooks', () => {
    expect(registry.hooks('connect').map((h) => h.fullName)).to.include('reg.hello');
    expect(registry.hooks('disconnect').map((h) => h.fullName)).to.include('reg.bye');
  });

  it('refuses two handlers with one name', async () => {
    DI.register(RegDupOne).as(BaseSocketController);
    DI.register(RegDupTwo).as(BaseSocketController);
    try {
      await expect(registry.build()).to.be.rejectedWith(/reg-dup\.same is declared twice/);
    } finally {
      DI.unregister(RegDupOne);
      DI.unregister(RegDupTwo);
    }
  });

  it('refuses parameter decorators without a handler decorator', async () => {
    DI.register(RegOrphan).as(BaseSocketController);
    try {
      await expect(registry.build()).to.be.rejectedWith(/RegOrphan::orphan has socket parameter or policy decorators but no/);
    } finally {
      DI.unregister(RegOrphan);
    }
  });

  it('refuses command and event names the wire would reject', async () => {
    for (const type of [RegBadName, RegLongName]) {
      DI.register(type).as(BaseSocketController);
      try {
        await expect(registry.build()).to.be.rejectedWith(/is not a valid socket (command|event) name/);
      } finally {
        DI.unregister(type);
      }
    }
  });

  it('rebuilds from scratch', async () => {
    await registry.build();
    expect(registry.command('reg.add')).to.exist;
  });
});
