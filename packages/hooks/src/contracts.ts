import { AsyncService } from '@spinajs/di';

/** Each package adds its actions with `declare module '@spinajs/hooks' { interface HookActions { ... } }`, in its src/hooks.ts. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HookActions {}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- `& string` keeps out a number or symbol key some package might declare
export type ActionName = keyof HookActions & string;
export type InputOf<A extends ActionName> = HookActions[A] extends { input: infer I } ? I : never;
export type OutputOf<A extends ActionName> = HookActions[A] extends { output: infer O } ? O : never;
/** An exact name, a prefix glob ('authn.*', 'authn.password.*') or '*'. */
export type ActionPattern = ActionName | `${string}.*` | '*';

export interface BeforeContext<A extends ActionName> {
  readonly action: A;
  /** Only the keys the action declares in RunOptions.mutable reach the action. */
  input: InputOf<A>;
  /** Shared by the before, after and failed calls of one run. */
  readonly bag: Map<string, unknown>;
  /** 1 for a top-level run; a hook that runs another action raises it. */
  readonly depth: number;
  /** `code` matches `/^[a-z0-9][a-z0-9_.-]{0,58}$/`, so the audit reason `hook:<code>` fits the 64-character reason columns. */
  refuse(code: string, message?: string): never;
}

export interface AfterContext<A extends ActionName> {
  readonly action: A;
  readonly input: Readonly<InputOf<A>>;
  readonly output: OutputOf<A>;
  readonly bag: Map<string, unknown>;
  readonly depth: number;
}

export interface FailedContext<A extends ActionName> {
  readonly action: A;
  readonly input: Readonly<InputOf<A>>;
  readonly error: unknown;
  readonly bag: Map<string, unknown>;
  readonly depth: number;
}

export abstract class ActionHook<A extends ActionName = ActionName> {
  abstract readonly actions: readonly ActionPattern[];
  /** Lower runs first in before, last in after and failed. Ties keep registration order. */
  readonly order: number = 0;

  before?(ctx: BeforeContext<A>): void | Promise<void>;
  after?(ctx: AfterContext<A>): void | Promise<void>;
  failed?(ctx: FailedContext<A>): void | Promise<void>;
}

export interface RunOptions<A extends ActionName> {
  readonly mutable: readonly (keyof InputOf<A>)[];
  /** Default true. false: a refusal or an error in before is logged and the action runs anyway. */
  readonly refusable?: boolean;
}

export abstract class Hooks extends AsyncService {
  /** True when at least one registered hook matches the action. */
  abstract has(action: ActionName): boolean;
  abstract run<A extends ActionName>(action: A, input: InputOf<A>, impl: (input: InputOf<A>) => Promise<OutputOf<A>>, opts: RunOptions<A>): Promise<OutputOf<A>>;
}
