import type { ControllerEntry, RouteEntry, SourceRef } from '@spinajs/manifest';

/** An inherited route's code lives in its base, possibly in a dependency; the subclass is what the app can change. */
export const reportedAt = (c: ControllerEntry, r: RouteEntry): SourceRef => (r.inheritedFrom ? c.source : r.source);

export const routeName = (c: ControllerEntry, r: RouteEntry): string => `${c.className}.${r.handler}${r.inheritedFrom ? ` (inherited from ${r.inheritedFrom})` : ''}`;
