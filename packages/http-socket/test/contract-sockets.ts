import { BaseSocketController } from '../src/controller.js';
import { Command, OnEvent, Payload } from '../src/decorators.js';

// The file the contract-enforcement manifest lists for these controllers: in manifest mode the server imports it.
// The suite binds them to a prefix and a contract itself, per case.

export const seen: Array<{ command: string; payload: unknown }> = [];

export class ContractSocket extends BaseSocketController {
  @Command('say')
  public async say(@Payload() payload: { name: string }) {
    seen.push({ command: 'say', payload });
    return { hello: payload.name };
  }

  @Command('loose')
  public async loose(@Payload() payload: unknown) {
    seen.push({ command: 'loose', payload });
  }

  @OnEvent('ping')
  public async ping(@Payload() payload: unknown) {
    seen.push({ command: 'ping', payload });
  }
}

export class OkSocket extends BaseSocketController {
  @Command('say')
  public async say(@Payload() payload: { n: number }) {
    seen.push({ command: 'ok.say', payload });
  }
}
