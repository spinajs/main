/**
 * Right-aligns text by padding with spaces on the left
 * Usage: {{__textRight "hello" 10}}
 * Result: "     hello"
 * 
 * @param context - The text to align
 * @param length - The total length of the output string
 * @returns Right-aligned text, truncated if longer than length
 */
export function __textRight(context: string, length: number): string {
  if (context.length > length) {
    return context.substring(0, length);
  }
  return context.padStart(length, ' ');
}

/**
 * Center-aligns text by padding with spaces on both sides
 * Usage: {{__textCenter "hello" 10}}
 * Result: "  hello   "
 * 
 * @param context - The text to center
 * @param length - The total length of the output string
 * @returns Center-aligned text, truncated if longer than length
 */
export function __textCenter(context: string, length: number): string {
  if (context.length > length) {
    return context.substring(0, length);
  } else if (context.length === length) {
    return context;
  } else {
    const leftPadding = Math.floor((length - context.length) / 2);
    return context.padStart(leftPadding + context.length, ' ').padEnd(length, ' ');
  }
}

/**
 * Convert string to uppercase
 * Usage: {{uppercase "hello"}} → "HELLO"
 */
export function uppercase(str: string): string {
  return String(str || '').toUpperCase();
}

/**
 * Convert string to lowercase
 * Usage: {{lowercase "HELLO"}} → "hello"
 */
export function lowercase(str: string): string {
  return String(str || '').toLowerCase();
}

/**
 * Capitalize first letter of string
 * Usage: {{capitalize "hello world"}} → "Hello world"
 */
export function capitalize(str: string): string {
  const text = String(str || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Capitalize first letter of each word
 * Usage: {{capitalizeWords "hello world"}} → "Hello World"
 */
export function capitalizeWords(str: string): string {
  return String(str || '')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Truncate string to specified length with optional suffix
 * Usage: {{truncate "Hello World" 5}} → "Hello..."
 * Usage: {{truncate "Hello World" 5 "…"}} → "Hello…"
 */
export function truncate(str: string, length: number, suffix: string = '...'): string {
  const text = String(str || '');
  if (text.length <= length) return text;
  return text.substring(0, length) + suffix;
}

/**
 * Truncate string by word boundary
 * Usage: {{truncateWords "The quick brown fox" 2}} → "The quick..."
 */
export function truncateWords(str: string, count: number, suffix: string = '...'): string {
  const words = String(str || '').split(' ');
  if (words.length <= count) return str;
  return words.slice(0, count).join(' ') + suffix;
}

/**
 * Reverse string
 * Usage: {{reverse "hello"}} → "olleh"
 */
export function reverse(str: string): string {
  return String(str || '').split('').reverse().join('');
}

/**
 * Repeat string n times
 * Usage: {{repeat "hi" 3}} → "hihihi"
 */
export function repeat(str: string, count: number): string {
  return String(str || '').repeat(Math.max(0, count));
}

/**
 * Replace all occurrences in string
 * Usage: {{replace "hello world" "world" "universe"}} → "hello universe"
 */
export function replace(str: string, search: string, replacement: string): string {
  return String(str || '').split(search).join(replacement);
}

/**
 * Trim whitespace from both ends
 * Usage: {{trim "  hello  "}} → "hello"
 */
export function trim(str: string): string {
  return String(str || '').trim();
}

/**
 * Trim whitespace from left
 * Usage: {{trimLeft "  hello"}} → "hello"
 */
export function trimLeft(str: string): string {
  return String(str || '').trimStart();
}

/**
 * Trim whitespace from right
 * Usage: {{trimRight "hello  "}} → "hello"
 */
export function trimRight(str: string): string {
  return String(str || '').trimEnd();
}

/**
 * Split string into array
 * Usage: {{split "a,b,c" ","}} → ["a", "b", "c"]
 */
export function split(str: string, separator: string): string[] {
  return String(str || '').split(separator);
}

/**
 * Join array into string
 * Usage: {{join items ", "}}
 */
export function join(arr: any[], separator: string = ', '): string {
  if (!Array.isArray(arr)) return '';
  return arr.join(separator);
}

/**
 * Get substring
 * Usage: {{substring "hello world" 0 5}} → "hello"
 */
export function substring(str: string, start: number, end?: number): string {
  return String(str || '').substring(start, end);
}

/**
 * Get string length
 * Usage: {{length "hello"}} → 5
 */
export function length(str: string | any[]): number {
  if (Array.isArray(str)) return str.length;
  return String(str || '').length;
}

/**
 * Pad string on the left
 * Usage: {{padLeft "5" 3 "0"}} → "005"
 */
export function padLeft(str: string, length: number, char: string = ' '): string {
  return String(str || '').padStart(length, char);
}

/**
 * Pad string on the right
 * Usage: {{padRight "5" 3 "0"}} → "500"
 */
export function padRight(str: string, length: number, char: string = ' '): string {
  return String(str || '').padEnd(length, char);
}

/**
 * Remove HTML tags from string
 * Usage: {{stripHtml "<p>Hello</p>"}} → "Hello"
 */
export function stripHtml(str: string): string {
  return String(str || '').replace(/<[^>]*>/g, '');
}

/**
 * Escape HTML special characters
 * Usage: {{escapeHtml "<div>"}} → "&lt;div&gt;"
 */
export function escapeHtml(str: string): string {
  const text = String(str || '');
  const map: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, char => map[char]);
}

/**
 * Convert string to URL-friendly slug
 * Usage: {{slugify "Hello World!"}} → "hello-world"
 */
export function slugify(str: string): string {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert string to camelCase
 * Usage: {{camelCase "hello world"}} → "helloWorld"
 */
export function camelCase(str: string): string {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase());
}

/**
 * Convert string to snake_case
 * Usage: {{snakeCase "helloWorld"}} → "hello_world"
 */
export function snakeCase(str: string): string {
  return String(str || '')
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Convert string to kebab-case
 * Usage: {{kebabCase "helloWorld"}} → "hello-world"
 */
export function kebabCase(str: string): string {
  return String(str || '')
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
