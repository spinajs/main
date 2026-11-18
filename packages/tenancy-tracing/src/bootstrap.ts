import { Autoinject, Bootstrapper, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ensureTracing, readTracingOptions, tracingState } from '@spinajs/tracing';
import type { SpanProcessorHub } from '@spinajs/tracing';

import { TenantSpanProcessor } from './processor.js';

let attachedTo: SpanProcessorHub | undefined;

function attachToHub(configuration: Configuration): void {
  const state = tracingState().owner === 'none' ? ensureTracing(readTracingOptions(configuration)) : tracingState();
  if (!state.hub || state.hub === attachedTo) return;
  state.hub.add(new TenantSpanProcessor(), { enricher: true });
  attachedTo = state.hub;
}

@Injectable(Bootstrapper)
export class TenantTracingBootstrapper extends Bootstrapper {
  @Autoinject(Container)
  protected Container!: IContainer;

  public bootstrap(): void {
    // The hub exists once TracingBootstrapper has seen Configuration, which bootstrappers run before.
    const configuration = this.Container.isResolved(Configuration) ? this.Container.get(Configuration) : null;
    if (configuration) {
      attachToHub(configuration);
      return;
    }
    this.Container.once('di.resolved.Configuration', (_container: unknown, resolved: unknown) => {
      attachToHub(resolved as Configuration);
    });
  }
}
