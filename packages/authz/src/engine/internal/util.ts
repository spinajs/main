/** Any non-null object, arrays included, unlike `isPlainObject` from `@spinajs/util`. */
export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
