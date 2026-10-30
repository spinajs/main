import { BaseSocketController } from '../src/controller.js';
import { Command, FromDI, Payload } from '../src/decorators.js';

// The file the runtime-type manifest lists for the controller and names as the `@Payload` type. The suite binds the
// controller to its prefix itself.

export class TypedItem {
  public name: string;

  constructor(data: Partial<TypedItem>) {
    Object.assign(this, data);
  }
}

export class Injected {
  public readonly kind = 'injected';
}

// Decorated by hand: TypeScript emits `design:paramtypes` only for decorators it applies itself.
export class UntypedSocket extends BaseSocketController {
  public async create(payload: { name: string }) {
    return { type: payload.constructor.name, name: payload.name };
  }

  public async inject(_payload: { name: string }, injected: Injected) {
    return { kind: injected.kind };
  }
}
Payload()(UntypedSocket.prototype, 'create', 0);
Command('create')(UntypedSocket.prototype, 'create', Object.getOwnPropertyDescriptor(UntypedSocket.prototype, 'create'));
Payload()(UntypedSocket.prototype, 'inject', 0);
FromDI()(UntypedSocket.prototype, 'inject', 1);
Command('inject')(UntypedSocket.prototype, 'inject', Object.getOwnPropertyDescriptor(UntypedSocket.prototype, 'inject'));
