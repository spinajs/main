import { BaseSocketController, Command, OnEvent, Payload, SocketController } from '@spinajs/http-socket';

export type ChatMessage = { id: string; text: string };

@SocketController('chat')
export class ChatSocketController extends BaseSocketController {
  @Command('send', { idempotent: true })
  public async send(@Payload() payload: { text: string }): Promise<{ id: string }> {
    return { id: `m-${payload.text.length}` };
  }

  @Command('history')
  public async *history(@Payload() payload: { since: string }): AsyncIterable<ChatMessage> {
    yield { id: payload.since, text: 'hello' };
  }

  @OnEvent('message')
  public onMessage(@Payload() payload: ChatMessage): void {
    void payload;
  }
}
