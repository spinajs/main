import type { IMappableService } from '@spinajs/di';

/** Longer tokens count as missing: no provider issues one this long, and it bounds what reaches the verifier. */
export const BOT_TOKEN_MAX_LENGTH = 2048;

/** Retry-After of the 503 an unavailable verifier answers with `onUnavailable: 'refuse'`. */
export const BOT_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

export interface BotCheckInput {
  readonly token: string;
  /** The check's `action`, or its name; score providers compare it with the action the client sent. */
  readonly action: string;
  readonly ip?: string;
  readonly hostname?: string;
}

export type BotVerdict =
  | { readonly result: 'passed'; readonly score?: number }
  | { readonly result: 'failed'; readonly reason: string; readonly score?: number }
  | { readonly result: 'unavailable'; readonly reason: string };

/** One `http.bot.verifiers` entry; adapters add their own options next to these. */
export interface IBotVerifierOptions {
  readonly service: string;
  readonly name: string;
}

export type BotUnavailableMode = 'refuse' | 'allow';

/** `http.bot.checks.<name>`, the name given to `@BotCheck(name)`. */
export interface IBotCheckConfiguration {
  readonly enabled?: boolean;
  /** The `name` of an `http.bot.verifiers` entry. */
  readonly verifier: string;
  /** Sent to the verifier as the expected action; the check name when absent. */
  readonly action?: string;
  readonly onUnavailable?: BotUnavailableMode;
  /** The verifier the client is told to show after a failed token, eg. a challenge captcha after a low score. */
  readonly fallback?: string;
}

export interface IBotConfiguration {
  readonly enabled?: boolean;
  readonly header?: string;
  /** Names which verifier the token is for; only the check's verifier or its fallback is accepted. */
  readonly verifierHeader?: string;
  readonly verifiers?: readonly IBotVerifierOptions[];
  readonly checks?: Readonly<Record<string, IBotCheckConfiguration>>;
}

/**
 * A bot verification provider (a captcha or a score service). Instances are built from the `http.bot.verifiers`
 * entries and keyed by their `name`.
 */
export abstract class BotVerifier implements IMappableService {
  /** Set from the config entry's `name`; the `checks.*.verifier` value refers to it. */
  public Name: string;

  constructor(options?: Partial<IBotVerifierOptions>) {
    this.Name = options?.name ?? this.constructor.name;
  }

  public get ServiceName(): string {
    return this.Name;
  }

  public abstract verify(input: BotCheckInput): Promise<BotVerdict>;
}
