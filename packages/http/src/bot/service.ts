import type * as express from 'express';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { AsyncService, Autoinject, Container, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';

import { BOT_TOKEN_MAX_LENGTH, BotVerifier } from './contracts.js';
import type { BotVerdict, IBotCheckConfiguration, IBotConfiguration } from './contracts.js';
import { BotCheckFailed } from './errors.js';

const DEFAULT_TOKEN_HEADER = 'x-bot-token';
const DEFAULT_VERIFIER_HEADER = 'x-bot-verifier';
const UNAVAILABLE_WARNING_PERIOD_MS = 60_000;

/** The `http.bot.verifiers` entries as instances keyed by name. Resolved only once a check is on. */
@Injectable()
@Singleton()
export class BotVerifierRegistry {
  @AutoinjectService('http.bot.verifiers', BotVerifier)
  public readonly Verifiers: Map<string, BotVerifier>;
}

/**
 * Runs the `http.bot.checks.<name>` check for `@BotCheck(name)`. Off unless both `http.bot.enabled` and the check's
 * `enabled` are true; then no verifier is resolved at all.
 */
@Injectable()
@Singleton()
export class BotCheckService extends AsyncService {
  @Config('http.bot')
  protected Options: IBotConfiguration | undefined;

  @Autoinject(Container)
  protected Container: IContainer;

  @Logger('http')
  protected Log: Log;

  protected Verifiers: Map<string, BotVerifier> | null = null;

  protected LastUnavailableWarning = new Map<string, number>();

  public async resolve(): Promise<void> {
    if (this.enabledChecks().length > 0) {
      await this.verifiers();
    }
  }

  /** The configuration of `check` when it runs, otherwise null. */
  public checkFor(check: string): IBotCheckConfiguration | null {
    const options = this.Options;
    if (options?.enabled !== true) return null;
    const cfg = options.checks?.[check];
    return cfg?.enabled === true ? cfg : null;
  }

  /** Throws BotCheckFailed when the request does not pass `check`; a check that is off passes. */
  public async check(check: string, req: express.Request): Promise<void> {
    const cfg = this.checkFor(check);
    if (!cfg) return;

    const token = this.tokenOf(check, req);
    const verifierName = this.verifierFor(check, cfg, req);
    const verifier = (await this.verifiers()).get(verifierName)!;
    const verdict = await this.verify(verifier, {
      token,
      action: cfg.action ?? check,
      ip: (req as { storage?: { realIp?: string } }).storage?.realIp ?? req.ip,
      hostname: req.hostname,
    });

    switch (verdict.result) {
      case 'passed':
        return;
      case 'failed':
        this.Log.debug({ check, verifier: verifierName, reason: verdict.reason }, 'Bot check ${check} failed at ${verifier}: ${reason}');
        throw new BotCheckFailed(check, 'failed', verifierName === cfg.verifier ? cfg.fallback : undefined);
      default:
        if (cfg.onUnavailable === 'allow') {
          this.warnUnavailable(check, verifierName, verdict.reason);
          return;
        }
        this.Log.warn({ check, verifier: verifierName, reason: verdict.reason }, 'Bot check ${check} refused: verifier ${verifier} is unavailable (${reason})');
        throw new BotCheckFailed(check, 'unavailable');
    }
  }

  protected tokenOf(check: string, req: express.Request): string {
    const token = req.get(this.Options?.header ?? DEFAULT_TOKEN_HEADER);
    if (typeof token !== 'string' || token.length === 0 || token.length > BOT_TOKEN_MAX_LENGTH) {
      throw new BotCheckFailed(check, 'missing');
    }
    return token;
  }

  /** The check's verifier, or its fallback when the client names it; naming any other verifier fails the check. */
  protected verifierFor(check: string, cfg: IBotCheckConfiguration, req: express.Request): string {
    const requested = req.get(this.Options?.verifierHeader ?? DEFAULT_VERIFIER_HEADER);
    if (requested === undefined || requested === cfg.verifier) return cfg.verifier;
    if (requested !== cfg.fallback) throw new BotCheckFailed(check, 'failed');
    return requested;
  }

  protected async verify(verifier: BotVerifier, input: Parameters<BotVerifier['verify']>[0]): Promise<BotVerdict> {
    try {
      return await verifier.verify(input);
    } catch (err) {
      this.Log.error({ error: err, verifier: verifier.Name }, 'Bot verifier ${verifier} threw');
      return { result: 'unavailable', reason: 'error' };
    }
  }

  protected warnUnavailable(check: string, verifier: string, reason: string): void {
    const now = Date.now();
    const last = this.LastUnavailableWarning.get(check);
    if (last !== undefined && now - last < UNAVAILABLE_WARNING_PERIOD_MS) return;
    this.LastUnavailableWarning.set(check, now);
    this.Log.warn({ check, verifier, reason }, 'Bot check ${check} let requests through: verifier ${verifier} is unavailable (${reason})');
  }

  protected enabledChecks(): [string, IBotCheckConfiguration][] {
    return Object.keys(this.Options?.checks ?? {})
      .map((name) => [name, this.checkFor(name)] as [string, IBotCheckConfiguration | null])
      .filter((entry): entry is [string, IBotCheckConfiguration] => entry[1] !== null);
  }

  protected async verifiers(): Promise<Map<string, BotVerifier>> {
    if (this.Verifiers) return this.Verifiers;
    const verifiers = (await this.Container.resolve(BotVerifierRegistry)).Verifiers ?? new Map<string, BotVerifier>();
    for (const [name, cfg] of this.enabledChecks()) {
      for (const key of ['verifier', 'fallback'] as const) {
        const value = cfg[key];
        if ((key === 'verifier' || value !== undefined) && !verifiers.has(value as string)) {
          throw new InvalidOption(`http.bot.checks.${name}.${key} ${JSON.stringify(value)}: no http.bot.verifiers entry has that name (configured: ${[...verifiers.keys()].join(', ') || 'none'})`);
        }
      }
    }
    this.Verifiers = verifiers;
    return verifiers;
  }
}
