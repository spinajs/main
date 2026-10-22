import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { BotVerifier } from '@spinajs/http';
import type { BotCheckInput, BotVerdict, IBotVerifierOptions } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { BotHttpError, postFormForJson } from './fetch.js';

export const RECAPTCHA_SITEVERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

export interface IRecaptchaOptions extends IBotVerifierOptions {
  readonly secret: string;
  /** Hostnames the token may have been issued on; empty or absent accepts any. */
  readonly expectedHostnames?: readonly string[];
  /** Oldest accepted `challenge_ts`, default 120. */
  readonly maxAgeSeconds?: number;
  /** Default 3000. */
  readonly timeoutMs?: number;
  /** Default RECAPTCHA_SITEVERIFY_URL; must be https (eg. the www.recaptcha.net mirror). */
  readonly endpoint?: string;
}

export interface IRecaptchaV3Options extends IRecaptchaOptions {
  /** Lowest passing score, 0.0 (bot) to 1.0 (human); default 0.5. */
  readonly minScore?: number;
}

interface ISiteverifyAnswer {
  readonly success: boolean;
  readonly score?: unknown;
  readonly action?: unknown;
  readonly challenge_ts?: unknown;
  readonly hostname?: unknown;
  readonly 'error-codes'?: unknown;
}

const MISCONFIGURATION_CODES = ['missing-input-secret', 'invalid-input-secret'];

function isAnswer(value: unknown): value is ISiteverifyAnswer {
  return typeof value === 'object' && value !== null && typeof (value as { success?: unknown }).success === 'boolean';
}

/** Shared `siteverify` call and checks; the secret goes only into the request form. */
abstract class RecaptchaVerifier extends BotVerifier {
  @Logger('http-bot')
  protected Log: Log;

  protected readonly Secret: string;
  protected readonly ExpectedHostnames: readonly string[];
  protected readonly MaxAgeSeconds: number;
  protected readonly TimeoutMs: number;
  protected readonly Endpoint: string;

  constructor(options: IRecaptchaOptions) {
    super(options);
    if (typeof options?.secret !== 'string' || options.secret.length === 0) {
      throw new InvalidOption(`http.bot.verifiers ${JSON.stringify(this.Name)}: secret is not set`);
    }
    this.Secret = options.secret;
    this.ExpectedHostnames = options.expectedHostnames ?? [];
    this.MaxAgeSeconds = options.maxAgeSeconds ?? 120;
    this.TimeoutMs = options.timeoutMs ?? 3000;
    this.Endpoint = options.endpoint ?? RECAPTCHA_SITEVERIFY_URL;
    if (new URL(this.Endpoint).protocol !== 'https:') {
      throw new InvalidOption(`http.bot.verifiers ${JSON.stringify(this.Name)}: endpoint must be https`);
    }
  }

  public async verify(input: BotCheckInput): Promise<BotVerdict> {
    const form: Record<string, string> = { secret: this.Secret, response: input.token };
    if (input.ip) form.remoteip = input.ip;

    let answer: unknown;
    try {
      answer = await postFormForJson(this.Endpoint, form, this.TimeoutMs);
    } catch (err) {
      const reason = err instanceof BotHttpError ? err.failure : 'error';
      this.Log.warn({ verifier: this.Name, reason, status: err instanceof BotHttpError ? err.status : undefined }, 'reCAPTCHA verifier ${verifier} is unavailable: ${reason}');
      return { result: 'unavailable', reason };
    }
    if (!isAnswer(answer)) {
      this.Log.warn({ verifier: this.Name }, 'reCAPTCHA verifier ${verifier} got an answer without success');
      return { result: 'unavailable', reason: 'invalid_answer' };
    }

    return answer.success ? this.judgeSuccess(answer, input) : this.judgeRefusal(answer);
  }

  protected judgeRefusal(answer: ISiteverifyAnswer): BotVerdict {
    const codes = Array.isArray(answer['error-codes']) ? answer['error-codes'].filter((c): c is string => typeof c === 'string') : [];
    if (codes.some((c) => MISCONFIGURATION_CODES.includes(c))) {
      this.Log.error({ verifier: this.Name, codes: codes.join(', ') }, 'reCAPTCHA verifier ${verifier} is misconfigured: ${codes}; check its secret');
      return { result: 'unavailable', reason: 'misconfigured' };
    }
    return { result: 'failed', reason: codes[0] ?? 'rejected' };
  }

  protected judgeSuccess(answer: ISiteverifyAnswer, input: BotCheckInput): BotVerdict {
    if (this.ExpectedHostnames.length > 0 && !(typeof answer.hostname === 'string' && this.ExpectedHostnames.includes(answer.hostname))) {
      return { result: 'failed', reason: 'hostname_mismatch' };
    }
    const issued = typeof answer.challenge_ts === 'string' ? Date.parse(answer.challenge_ts) : NaN;
    if (Number.isNaN(issued) || Date.now() - issued > this.MaxAgeSeconds * 1000) {
      return { result: 'failed', reason: 'stale_token' };
    }
    return this.judge(answer, input);
  }

  protected abstract judge(answer: ISiteverifyAnswer, input: BotCheckInput): BotVerdict;
}

/** reCAPTCHA v3: an invisible score check. Passes at `score >= minScore` for the check's action. */
@Injectable(BotVerifier)
@NewInstance()
export class RecaptchaV3Verifier extends RecaptchaVerifier {
  protected readonly MinScore: number;

  constructor(options: IRecaptchaV3Options) {
    super(options);
    this.MinScore = options.minScore ?? 0.5;
  }

  protected judge(answer: ISiteverifyAnswer, input: BotCheckInput): BotVerdict {
    if (answer.action !== input.action) {
      return { result: 'failed', reason: 'action_mismatch' };
    }
    if (typeof answer.score !== 'number') {
      return { result: 'failed', reason: 'no_score' };
    }
    if (answer.score < this.MinScore) {
      return { result: 'failed', reason: 'low_score', score: answer.score };
    }
    return { result: 'passed', score: answer.score };
  }
}

/** reCAPTCHA v2: the challenge captcha ("I'm not a robot" or invisible). Has no score or action. */
@Injectable(BotVerifier)
@NewInstance()
export class RecaptchaV2Verifier extends RecaptchaVerifier {
  protected judge(): BotVerdict {
    return { result: 'passed' };
  }
}
