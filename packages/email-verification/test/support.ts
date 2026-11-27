import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { inspect } from 'node:util';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import '../src/register-schema.js';

let overrides: Record<string, unknown> = {};

// onLoad, not resolve: values merged after resolve() would skip the schema defaults.
export class EmailVerificationTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      emailVerification: { enabled: true, ...overrides },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

const owned = new Set<unknown>([Configuration, EmailVerificationTestConfiguration]);
let registered = false;

/** Disposes and uncaches every type a boot owned. */
export async function shutdown(): Promise<void> {
  for (const t of owned) {
    const instance = DI.get(t as Class<unknown>) as { dispose?: () => Promise<void> } | undefined;
    if (instance && !Array.isArray(instance) && typeof instance.dispose === 'function') {
      await instance.dispose();
    }
    DI.uncache(t as never);
  }
}

/** Boots Configuration with `options` merged over `emailVerification` and resolves `type`; `types` lists what to uncache next time. */
export async function boot<T>(type: Class<T>, options: Record<string, unknown> = {}, types: unknown[] = []): Promise<T> {
  await shutdown();
  if (!registered) {
    // The configuration loader reads every @spinajs package's config; without this it tries their CommonJS builds.
    DI.setESMModuleSupport();
    DI.register(EmailVerificationTestConfiguration).as(Configuration);
    registered = true;
  }
  [type, ...types].forEach((t) => owned.add(t));
  overrides = options;
  await DI.resolve(Configuration);
  const instance: unknown = await DI.resolve(type);
  return instance as T;
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { calls: FetchCall[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Makes every DNS lookup and resolve call record its name and throw, so a test can prove nothing was resolved. */
export function dnsTripwire(): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const names = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt'];
  const targets = [dns, dns.promises].flatMap((owner) => names.map((name) => ({ owner, name, original: Reflect.get(owner, name) as unknown })));
  for (const t of targets) {
    Reflect.set(t.owner, t.name, () => {
      calls.push(t.name);
      throw new Error(`a test called dns.${t.name}`);
    });
  }
  return { calls, restore: () => targets.forEach((t) => Reflect.set(t.owner, t.name, t.original)) };
}

/** Made-up credentials and a query token in a URL on a host that must never be resolved. */
export function credentialUrl(parts: { user?: boolean; password?: boolean } = { user: true, password: true }, scheme = 'https://') {
  const user = randomBytes(12).toString('hex');
  const password = randomBytes(12).toString('hex');
  const token = randomBytes(12).toString('hex');
  const userinfo = `${parts.user ? user : ''}${parts.password ? `:${password}` : ''}@`;
  return { url: `${scheme}${userinfo}lists.invalid/x?token=${token}`, secrets: [...(parts.user ? [user] : []), ...(parts.password ? [password] : []), token] };
}

/** Every 8-character run of a secret that appears in `text`. */
export function leakedRuns(text: string, secrets: string[]): string[] {
  return secrets.flatMap((s) => Array.from({ length: s.length - 7 }, (_, i) => s.slice(i, i + 8))).filter((run) => text.includes(run));
}

export function errorText(err: Error): string {
  return [err.message, err.stack, inspect(err, { depth: null, showHidden: true }), inspect(err.cause, { depth: null, showHidden: true })].join('\n');
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const text = (status: number, body: string, headers: Record<string, string> = {}) => new Response(status === 304 ? null : body, { status, headers });
