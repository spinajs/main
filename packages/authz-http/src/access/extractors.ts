import type { ResourceType } from '@spinajs/authz';

import type { ResourceExtractor } from '../api.js';

const EXTRACTOR_TYPE = Symbol.for('authz:access:extractor-type');

/** Marks the resource type an extractor yields, so boot checks and swagger can read it. */
export function typedExtractor(type: ResourceType, fn: ResourceExtractor): ResourceExtractor {
  Object.defineProperty(fn, EXTRACTOR_TYPE, { value: type });
  return fn;
}

/** The type an extractor declared through `typedExtractor`; undefined for a custom one. */
export function extractorType(extractor: ResourceExtractor | undefined): ResourceType | undefined {
  return extractor ? ((extractor as unknown as Record<symbol, ResourceType | undefined>)[EXTRACTOR_TYPE] ?? undefined) : undefined;
}
