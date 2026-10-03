import type { ClientEventName, ClientEventPayload, CommandName, CommandPayload, CommandResult, ContractShape, EventName, EventPayload } from '@spinajs/http-socket-common';
import type { ClientLifecycleEvents, LifecycleEventName, Unsubscribe } from './client.js';
import type { CommandOptions } from './commands.js';
import type { ConnectionState } from './connection.js';
import type { StreamOptions } from './streams.js';

/** A stream command declares its result as AsyncIterable<Item>; stream() yields the items. */
export type StreamItem<C extends ContractShape, N extends CommandName<C>> = CommandResult<C, N> extends AsyncIterable<infer T> ? T : CommandResult<C, N>;

/** A SocketClient seen through a contract: names and payloads are checked at compile time. */
export interface TypedSocketClient<C extends ContractShape> {
  readonly clientId: string;
  readonly state: ConnectionState;
  connect(): void;
  disconnect(): void;
  close(): void;
  command<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>, options?: CommandOptions): Promise<CommandResult<C, N>>;
  durable<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>): Promise<CommandResult<C, N>>;
  stream<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>, options?: StreamOptions): AsyncIterableIterator<StreamItem<C, N>>;
  emit<N extends ClientEventName<C>>(name: N, payload: ClientEventPayload<C, N>): boolean;
  on<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  on<N extends EventName<C>>(event: N, listener: (payload: EventPayload<C, N>) => void): Unsubscribe;
  once<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  once<N extends EventName<C>>(event: N, listener: (payload: EventPayload<C, N>) => void): Unsubscribe;
  off<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): void;
  off<N extends EventName<C>>(event: N, listener: (payload: EventPayload<C, N>) => void): void;
}
