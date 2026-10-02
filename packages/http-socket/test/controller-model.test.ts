import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ArgHydrator, BasePolicy, Hydrator } from '@spinajs/http';
import { DataValidator, Schema, ValidationFailed } from '@spinajs/validation';
import { UNATTENDED } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, FromDI, OnConnect, OnDisconnect, OnEvent, Payload, Reason, Signal, SocketController, SocketPolicy } from '../src/decorators.js';
import { ConnectionArg, FromDiArg, PayloadArg, ReasonArg, SignalArg, SocketArgumentResolver } from '../src/args.js';
import { IRegisteredHandler, ISocketCallContext, ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from '../src/interfaces.js';
import { SocketConnection } from '../src/connection.js';
import { configure } from './harness.js';

export class ModelAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@Schema({ type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } } })
export class ModelCreateDoc {
  public title: string;

  constructor(data: Partial<ModelCreateDoc> = {}) {
    Object.assign(this, data);
  }
}

export class ModelShoutHydrator extends ArgHydrator {
  public async hydrate(input: { text: string }): Promise<ModelShout> {
    return new ModelShout(String(input.text).toUpperCase());
  }
}

@Hydrator(ModelShoutHydrator)
export class ModelShout {
  constructor(public text: string) {}
}

@SocketController('model')
@SocketPolicy(ModelAllow)
export class ModelSocket extends BaseSocketController {
  @Command('create', { timeoutMs: 1000, ordered: 'connection', idempotent: true })
  public async create(@Payload() doc: ModelCreateDoc, @Connection() conn: SocketConnection, @Signal() signal: AbortSignal) {
    return { doc, conn, signal };
  }

  @Command('strict', { schema: { type: 'object', required: ['x'] } })
  public async strict(@Payload() body: ModelCreateDoc) {
    return body;
  }

  @Command('shout')
  public async shout(@Payload() shout: ModelShout) {
    return shout;
  }

  @Command()
  @SocketPolicy([ModelAllow, ModelAllow])
  public async plain(@FromDI() validator: DataValidator) {
    return validator;
  }

  @OnEvent('cursor')
  public async cursor(@Payload() at: unknown) {
    return at;
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {
    return conn;
  }

  @OnDisconnect()
  public async left(@Reason() reason: string) {
    return reason;
  }
}

export class ModelParent extends BaseSocketController {
  @Command('shared')
  public async shared() {
    return 'parent';
  }
}

@SocketController('model-kid')
export class ModelKid extends ModelParent {
  @Command('own')
  public async own() {
    return 'kid';
  }
}

export class ModelProbe extends BaseSocketController {
  public probe(): void {}
}

const descriptorOf = (type: { prototype: object }): ISocketControllerDescriptor => Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, type.prototype) as ISocketControllerDescriptor;

describe('socket controller model', function () {
  this.timeout(15000);

  describe('descriptor', () => {
    it('collects the prefix and controller-wide policies', () => {
      const d = descriptorOf(ModelSocket);
      expect(d.Prefix).to.equal('model');
      expect(d.Policies).to.have.length(1);
      expect(d.Policies[0][0].Type).to.equal(ModelAllow);
    });

    it('describes a command with its options and parameters', () => {
      const h = descriptorOf(ModelSocket).Handlers.get('create')!;
      expect(h.Kind).to.equal('command');
      expect(h.Name).to.equal('create');
      expect(h.Options).to.deep.equal({ timeoutMs: 1000, ordered: 'connection', idempotent: true });
      expect([0, 1, 2].map((i) => h.Parameters.get(i)!.Type)).to.deep.equal([PayloadArg, ConnectionArg, SignalArg]);
      expect(h.Parameters.get(0)!.RuntimeType).to.equal(ModelCreateDoc);
    });

    it('names a handler after its method by default and keeps policy groups', () => {
      const h = descriptorOf(ModelSocket).Handlers.get('plain')!;
      expect(h.Name).to.equal('plain');
      expect(h.Policies).to.have.length(1);
      expect(h.Policies[0]).to.have.length(2);
      expect(h.Parameters.get(0)!.Type).to.equal(FromDiArg);
      expect(h.Parameters.get(0)!.RuntimeType).to.equal(DataValidator);
    });

    it('marks events and lifecycle hooks', () => {
      const d = descriptorOf(ModelSocket);
      expect(d.Handlers.get('cursor')!.Kind).to.equal('event');
      expect(d.Handlers.get('joined')!.Kind).to.equal('connect');
      expect(d.Handlers.get('left')!.Kind).to.equal('disconnect');
      expect(d.Handlers.get('left')!.Parameters.get(0)!.Type).to.equal(ReasonArg);
    });

    it('refuses two handler kinds on one method', () => {
      const member = Object.getOwnPropertyDescriptor(ModelProbe.prototype, 'probe')!;
      OnEvent()(ModelProbe.prototype, 'probe', member);
      expect(() => Command()(ModelProbe.prototype, 'probe', member)).to.throw(/already a socket event handler/);
    });

    it('keeps parent and subclass descriptors apart', () => {
      const parent = descriptorOf(ModelParent);
      const kid = descriptorOf(ModelKid);
      expect([...parent.Handlers.keys()]).to.deep.equal(['shared']);
      expect(parent.Prefix).to.be.null;
      expect([...kid.Handlers.keys()]).to.have.members(['shared', 'own']);
      expect(kid.Prefix).to.equal('model-kid');
      expect(kid.Handlers.get('shared')).not.to.equal(parent.Handlers.get('shared'));
    });

    it('registers decorated controllers in DI', () => {
      const types = DI.getRegisteredTypes(BaseSocketController);
      expect(types).to.include(ModelSocket);
      expect(types).to.include(ModelKid);
      expect(types).not.to.include(ModelParent);
    });
  });

  describe('argument extraction', () => {
    const connection = { id: 'conn-1', clientId: 'client-1' } as unknown as SocketConnection;
    let resolver: SocketArgumentResolver;

    const handlerOf = async (method: string): Promise<IRegisteredHandler> => {
      const controller = await DI.resolve(ModelSocket);
      return { fullName: `model.${method}`, controller, descriptor: controller.Descriptor!.Handlers.get(method)!, policies: { Controller: [], Route: [] } };
    };

    const call = (handler: IRegisteredHandler, payload: unknown, extra: Partial<ISocketCallContext> = {}): ISocketCallContext => ({
      kind: handler.descriptor.Kind,
      connection,
      handler,
      payload,
      signal: new AbortController().signal,
      storage: { Principal: UNATTENDED },
      ...extra,
    });

    beforeEach(async () => {
      await configure();
      resolver = await DI.resolve(SocketArgumentResolver);
    });

    it('validates and hydrates the payload against the DTO schema, and passes connection and signal', async () => {
      const signal = new AbortController().signal;
      const args = await resolver.resolve(call(await handlerOf('create'), { title: 'a' }, { signal }));
      expect(args[0]).to.be.instanceOf(ModelCreateDoc);
      expect((args[0] as ModelCreateDoc).title).to.equal('a');
      expect(args[1]).to.equal(connection);
      expect(args[2]).to.equal(signal);
    });

    it('rejects a payload that breaks the DTO schema', async () => {
      await expect(resolver.resolve(call(await handlerOf('create'), { title: '' }))).to.be.rejectedWith(ValidationFailed);
    });

    it('rejects a missing payload when a schema applies', async () => {
      await expect(resolver.resolve(call(await handlerOf('create'), undefined))).to.be.rejectedWith(InvalidArgument, /payload is required/);
    });

    it('prefers the command schema over the DTO schema', async () => {
      await expect(resolver.resolve(call(await handlerOf('strict'), { title: 'a' }))).to.be.rejectedWith(ValidationFailed);
    });

    it('uses a registered hydrator', async () => {
      const args = await resolver.resolve(call(await handlerOf('shout'), { text: 'hi' }));
      expect(args[0]).to.be.instanceOf(ModelShout);
      expect((args[0] as ModelShout).text).to.equal('HI');
    });

    it('injects services and the disconnect reason', async () => {
      const [validator] = await resolver.resolve(call(await handlerOf('plain'), undefined));
      expect(validator).to.be.instanceOf(DataValidator);
      expect(await resolver.resolve(call(await handlerOf('left'), undefined, { reason: 'transport close' }))).to.deep.equal(['transport close']);
    });

    it('passes an untyped payload through unchanged', async () => {
      const at = { x: 1 };
      const [arg] = await resolver.resolve(call(await handlerOf('cursor'), at));
      expect(arg).to.equal(at);
    });
  });
});
