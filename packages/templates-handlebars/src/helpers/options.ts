/**
 * Handlebars appends its `options` object as the last argument to every helper
 * invocation. Helpers whose last declared parameter is optional-with-default
 * would otherwise receive that object instead of the default value.
 *
 * NOTE: this module is intentionally NOT re-exported from `helpers/index.ts`,
 * so it is never registered as a Handlebars helper.
 *
 * @param value - the value to test
 * @returns true when the value is the Handlebars options object
 */
export function isHbOptions(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'hash' in value && 'data' in value;
}
