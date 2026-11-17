import { AuthzDomains } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import { tracingState } from '@spinajs/tracing';

import { TraceStore } from './buffers/trace-store.js';
import type { StudioFeatures } from './contracts/index.js';

export type StudioFeature = keyof StudioFeatures;
export type FeatureProbe = (container: IContainer) => boolean | Promise<boolean>;

// By registration name: Studio does not depend on @spinajs/telemetry or @spinajs/scheduler.
const registered = (name: string): FeatureProbe => (c) => c.hasRegistered(name) || c.isResolved(name);

const probes = new Map<StudioFeature, FeatureProbe>([
  // Recording, not merely configured: an external owner without the Studio processor, or a sampler that drops
  // everything, would show an empty page.
  ['traces', (c) => {
    if ((c.get(TraceStore)?.size ?? 0) > 0) return true;
    return tracingState().owner === 'spinajs' && c.get(Configuration)?.get<string>('tracing.sampler.type') !== 'never';
  }],
  ['authz', (c) => c.hasRegistered(AuthzDomains)],
  ['telemetry', registered('TelemetryStore')],
  ['scheduler', registered('SchedulerService')],
]);

export function registerStudioFeature(feature: StudioFeature, probe: FeatureProbe): void {
  probes.set(feature, probe);
}

export async function detectFeatures(container: IContainer): Promise<StudioFeatures> {
  const features: StudioFeatures = { traces: false, logs: false, slowQueries: false, di: false, routes: false, authz: false, rebac: false, telemetry: false, scheduler: false };
  for (const [feature, probe] of probes) {
    features[feature] = await probe(container);
  }
  return features;
}
