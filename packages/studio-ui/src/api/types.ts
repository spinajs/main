import type { StudioCapabilities, StudioSource } from '@spinajs/studio/contracts';

export type { StudioCapabilities, StudioPage, StudioSource } from '@spinajs/studio/contracts';

export type StudioFeature = keyof StudioCapabilities['features'];
export type DataOrigin = StudioSource;

/** `{ source, data }` as `GET /api/routes` answers it; the bare value elsewhere. */
export interface Sourced<T> {
  source?: DataOrigin;
  data: T;
}
