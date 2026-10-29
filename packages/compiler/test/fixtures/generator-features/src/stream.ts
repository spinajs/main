import { BaseSocketController, Command, Payload, SocketController } from '@spinajs/http-socket';

export class Item { public id: string }

@SocketController('stream')
export class StreamSocket extends BaseSocketController {
  @Command('iterable')
  public iterable(@Payload() p: Item): AsyncIterable<Item> { void p; return (async function* () { yield { id: '1' }; })(); }

  @Command('generator')
  public async *generator(@Payload() p: Item): AsyncGenerator<Item> { yield p; }

  @Command('iterator')
  public iterator(@Payload() p: Item): AsyncIterableIterator<Item> { void p; return (async function* () { yield { id: '1' }; })(); }

  @Command('plain')
  public async plain(@Payload() p: Item): Promise<Item[]> { return [p]; }
}
