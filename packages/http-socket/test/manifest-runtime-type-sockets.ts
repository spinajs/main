import { BaseSocketController } from '../src/controller.js';
import { Command, Payload } from '../src/decorators.js';

// The file the runtime-type manifest lists for the controller and names as the `@Payload` type. The suite binds the
// controller to its prefix itself.

export class TypedItem {
  public name: string;

  constructor(data: Partial<TypedItem>) {
    Object.assign(this, data);
  }
}

// Decorated by hand: TypeScript emits `design:paramtypes` only for decorators it applies itself.
export class UntypedSocket extends BaseSocketController {
  public async create(payload: { name: string }) {
    return { type: payload.constructor.name, name: payload.name };
  }
}
Payload()(UntypedSocket.prototype, 'create', 0);
Command('create')(UntypedSocket.prototype, 'create', Object.getOwnPropertyDescriptor(UntypedSocket.prototype, 'create'));
