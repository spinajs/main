import { Schema } from '@spinajs/validation';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnEvent, Payload } from '../src/decorators.js';

// The file the derived-payload manifest lists for this controller: in manifest mode the server imports it.
// The suite binds it to its prefix itself.

export const received: unknown[] = [];

@Schema({ $id: 'derived-payload.loose', type: 'object', properties: { name: { type: 'string' } }, required: ['name'] })
export class LooseItem {
  public name: string;
  public count: number;

  constructor(data: Partial<LooseItem>) {
    Object.assign(this, data);
  }
}

export class DerivedSocket extends BaseSocketController {
  @Command('create')
  public async create(@Payload() payload: { name: string; count: number }) {
    received.push(payload);
    return { name: payload.name };
  }

  @Command('loose')
  public async loose(@Payload() payload: LooseItem) {
    received.push(payload);
    return { name: payload.name };
  }

  @OnEvent('note')
  public async note(@Payload() payload: { name: string; count: number }) {
    received.push(payload);
  }
}
