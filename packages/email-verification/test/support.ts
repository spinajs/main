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

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const text = (status: number, body: string, headers: Record<string, string> = {}) => new Response(status === 304 ? null : body, { status, headers });
