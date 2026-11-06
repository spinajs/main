// Types only: `@spinajs/studio/contracts` is what the Studio UI compiles against.

export type StudioSource = 'manifest' | 'runtime' | 'merged';

export interface StudioFeatures {
  traces: boolean;
  logs: boolean;
  slowQueries: boolean;
  di: boolean;
  routes: boolean;
  authz: boolean;
  rebac: boolean;
  telemetry: boolean;
  scheduler: boolean;
}

/** `GET /_studio/api/capabilities` */
export interface StudioCapabilities {
  version: string;
  manifest: { loaded: boolean; hash?: string; mode?: 'off' | 'prefer' | 'require' };
  tracing: { owner: 'spinajs' | 'external' | 'none'; recording: boolean };
  features: StudioFeatures;
  /** Studio permissions the caller holds, so the UI can hide what it cannot open. */
  permissions: string[];
}

/** One page of a list; `cursor` is opaque to the client and goes back as the `cursor` query parameter. */
export interface StudioPage<T> {
  items: T[];
  total?: number;
  cursor?: string;
}
