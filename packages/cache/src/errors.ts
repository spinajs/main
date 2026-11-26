import { Exception } from '@spinajs/exceptions';

/** A cache, store or bus the configuration names wrongly. Thrown, never read as a miss. */
export class CacheConfigError extends Exception {}

/** A value node:v8 would not give back as it was. Thrown, never read as a miss. */
export class CacheValueNotSerializable extends Exception {}
