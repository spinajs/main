/**
 * One contract module is shared by the server and the client. Declare contracts with `type`,
 * not `interface`: only type aliases get the implicit index signature `Record<string, …>` needs.
 */
export interface ContractShape {
  /** command name → [payload, result] */
  commands: Record<string, readonly [unknown, unknown]>;
  /** server → client events: name → payload */
  events: Record<string, unknown>;
  /** client → server events: name → payload */
  clientEvents?: Record<string, unknown>;
}

export interface SocketContract<C extends ContractShape> {
  readonly kind: 'socket-contract';
  /** Type carrier only, never set at runtime. */
  readonly __contract?: C;
}

export function defineContract<C extends ContractShape>(): SocketContract<C> {
  return { kind: 'socket-contract' };
}

export type CommandName<C extends ContractShape> = Extract<keyof C['commands'], string>;
export type CommandPayload<C extends ContractShape, N extends CommandName<C>> = C['commands'][N][0];
export type CommandResult<C extends ContractShape, N extends CommandName<C>> = C['commands'][N][1];
export type EventName<C extends ContractShape> = Extract<keyof C['events'], string>;
export type EventPayload<C extends ContractShape, N extends EventName<C>> = C['events'][N];
export type ClientEventName<C extends ContractShape> = Extract<keyof NonNullable<C['clientEvents']>, string>;
export type ClientEventPayload<C extends ContractShape, N extends ClientEventName<C>> = NonNullable<C['clientEvents']>[N];
export type ContractOf<T> = T extends SocketContract<infer C> ? C : never;
