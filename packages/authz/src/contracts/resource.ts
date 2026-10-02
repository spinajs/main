import type { ResourceRef } from './principal.js';

export const GLOBAL: ResourceRef = Object.freeze({ type: '$global' });

// Feeds cache keys and invalidation tags, so it must be injective: the type
// part never contains ':', which leaves the first ':' as the separator and a
// type-level ref as the only key without one. The id stays raw ('uploads:a/b.pdf').
export const resourceKey = (r: ResourceRef): string => {
  const type = r.type.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\//g, '%2F');

  return r.id === undefined ? type : `${type}:${r.id}`;
};
