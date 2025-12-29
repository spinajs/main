import { __translate, __translateNumber, __translateL, __translateH } from '@spinajs/intl';

/**
 * Translation helper - translates a key to the current language
 * Usage: {{__ "hello"}}
 */
export function __(context: string, options: any) {
  return __translate(options.data.root.lang)(context);
}

/**
 * Pluralization helper - translates with count-based pluralization
 * Usage: {{__n "items" 5}}
 */
export function __n(context: string, count: number, options: any) {
  return __translateNumber(options.data.root.lang)(context, count);
}

/**
 * Translation helper for lowercase
 * Usage: {{__l "HELLO"}}
 */
export function __l(context: string) {
  return __translateL(context);
}

/**
 * Translation helper for HTML content
 * Usage: {{__h "html_content"}}
 */
export function __h(context: string) {
  return __translateH(context);
}
