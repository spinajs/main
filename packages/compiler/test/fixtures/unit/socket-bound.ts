declare function SocketController(prefix?: string, options?: { contract?: unknown }): ClassDecorator;
declare function Command(name?: string): MethodDecorator;
declare function Payload(): ParameterDecorator;
declare function defineContract<C>(id?: string): { kind: 'socket-contract'; __c?: C };

export class Greet { public name!: string }
export class Greeted { public hello!: string }
export class Waved { public count!: number }

export type GreetContract = {
  commands: { 'greet.say': [Greet, Greeted]; 'greet.bye': [Greet, void]; 'greet.wave': [Greet, Waved] };
  events: Record<string, never>;
  clientEvents: Record<string, never>;
};

export const GREET_CONTRACT = defineContract<GreetContract>();
export const NAMED_CONTRACT = defineContract<GreetContract>('greet.v1');

@SocketController('greet', { contract: GREET_CONTRACT })
export class GreetSocket {
  @Command('say')
  public async say(@Payload() payload: Greet): Promise<Greeted> { return { hello: payload.name }; }

  @Command('wave')
  public async wave(@Payload() payload: Greet): Promise<{ count: string }> { return { count: payload.name }; }
}

@SocketController('named', { contract: NAMED_CONTRACT })
export class NamedSocket {}

@SocketController('plain')
export class PlainSocket {}
