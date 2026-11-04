import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, isSpanContextValid, propagation, trace } from '@opentelemetry/api';
import type { ProxyTracerProvider, TracerProvider } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AlwaysOffSampler, AlwaysOnSampler, BasicTracerProvider, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import type { Sampler } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { Autoinject, Bootstrapper, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, registerConfigurationSchema } from '@spinajs/configuration';

import { TRACER_NAME } from './api.js';
import { HubSampler, SpanProcessorHub } from './hub.js';
import { DEFAULT_TRACING_OPTIONS, FALLBACK_SERVICE_NAME } from './options.js';
import type { TracingOptions } from './options.js';
import { W3C_PROPAGATOR } from './propagator.js';
import { TRACING_CONFIGURATION_SCHEMA } from './schemas/tracing.configuration.js';

export interface TracingState {
  owner: 'spinajs' | 'external' | 'none';
  hub?: SpanProcessorHub;
}

const NONE: TracingState = Object.freeze({ owner: 'none' });

let state: TracingState = NONE;
let provider: BasicTracerProvider | undefined;

// Checked by shape, not identity: a second copy of @opentelemetry/api registers its own proxy, whose no-op
// constant is another object. The probe span is a no-op on a NoopTracerProvider and ends at once on a real SDK.
function isNoopProvider(candidate: TracerProvider): boolean {
  if (candidate.constructor.name === 'NoopTracerProvider') return true;
  const probe = candidate.getTracer(`${TRACER_NAME}/probe`).startSpan('probe');
  const valid = isSpanContextValid(probe.spanContext());
  probe.end();
  return !valid;
}

function hasExternalProvider(): boolean {
  const global = trace.getTracerProvider() as TracerProvider & Partial<Pick<ProxyTracerProvider, 'getDelegate'>>;
  const delegate = typeof global.getDelegate === 'function' ? global.getDelegate() : global;
  return !isNoopProvider(delegate);
}

function delegateSampler(sampler: TracingOptions['sampler']): Sampler {
  const ratio = sampler.ratio ?? 1;
  switch (sampler.type) {
    case 'always':
      return new AlwaysOnSampler();
    case 'never':
      return new AlwaysOffSampler();
    case 'ratio':
      return new TraceIdRatioBasedSampler(ratio);
    default:
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
  }
}

export function tracingState(): TracingState {
  return state;
}

export function ensureTracing(options: TracingOptions): TracingState {
  if (state.owner !== 'none' || !options.enabled) return state;

  if (hasExternalProvider()) {
    state = Object.freeze({ owner: 'external' });
    return state;
  }

  const hub = new SpanProcessorHub();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(W3C_PROPAGATOR);
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, ...options.resourceAttributes }),
    sampler: new HubSampler(hub, delegateSampler(options.sampler)),
    spanProcessors: [hub],
  });
  trace.setGlobalTracerProvider(provider);

  state = Object.freeze({ owner: 'spinajs', hub });
  return state;
}

/** Tests only (exported as `resetTracing` from `@spinajs/tracing/testing`): globals of an external owner stay. */
export async function resetTracingState(): Promise<void> {
  const owned = provider;
  if (state.owner === 'spinajs') {
    trace.disable();
    context.disable();
    propagation.disable();
  }
  state = NONE;
  provider = undefined;
  await owned?.shutdown();
}

function appPackageName(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

export function readTracingOptions(cfg: Configuration): TracingOptions {
  return {
    enabled: cfg.get<boolean>('tracing.enabled', DEFAULT_TRACING_OPTIONS.enabled),
    serviceName: cfg.get<string | undefined>('tracing.serviceName', undefined) ?? appPackageName() ?? FALLBACK_SERVICE_NAME,
    resourceAttributes: cfg.get<Record<string, string>>('tracing.resourceAttributes', {}),
    sampler: cfg.get<TracingOptions['sampler']>('tracing.sampler', DEFAULT_TRACING_OPTIONS.sampler),
  };
}

@Injectable(Bootstrapper)
export class TracingBootstrapper extends Bootstrapper {
  @Autoinject(Container)
  protected Container!: IContainer;

  public bootstrap(): void {
    // The schema and the listener go to the same container: a child-scope app resolves its own Configuration.
    registerConfigurationSchema(TRACING_CONFIGURATION_SCHEMA, this.Container);

    // Bootstrappers run before Configuration resolves (cli.ts, createTestApp), so the provider waits for it.
    const configuration = this.Container.isResolved(Configuration) ? this.Container.get(Configuration) : null;
    if (configuration) {
      ensureTracing(readTracingOptions(configuration));
      return;
    }
    this.Container.once('di.resolved.Configuration', (_container: unknown, resolved: unknown) => {
      ensureTracing(readTracingOptions(resolved as Configuration));
    });
  }
}
