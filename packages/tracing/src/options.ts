export type SamplerType = 'always' | 'never' | 'ratio' | 'parent-ratio';

export interface TracingOptions {
  enabled: boolean;
  serviceName: string;
  resourceAttributes: Record<string, string>;
  sampler: { type: SamplerType; ratio?: number };
}

export const DEFAULT_TRACING_OPTIONS: Readonly<Omit<TracingOptions, 'serviceName'>> = {
  enabled: true,
  resourceAttributes: {},
  sampler: { type: 'parent-ratio', ratio: 1 },
};

export const FALLBACK_SERVICE_NAME = 'spinajs-app';
