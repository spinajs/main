/**
 * Addition
 * Usage: {{add 5 3}} → 8
 */
export function add(...args: any[]): number {
  const values = args.slice(0, -1).map(v => Number(v) || 0);
  return values.reduce((sum, val) => sum + val, 0);
}

/**
 * Subtraction
 * Usage: {{subtract 10 3}} → 7
 */
export function subtract(a: any, b: any): number {
  return (Number(a) || 0) - (Number(b) || 0);
}

/**
 * Multiplication
 * Usage: {{multiply 5 3}} → 15
 */
export function multiply(...args: any[]): number {
  const values = args.slice(0, -1).map(v => Number(v) || 0);
  return values.reduce((product, val) => product * val, 1);
}

/**
 * Division
 * Usage: {{divide 10 2}} → 5
 */
export function divide(a: any, b: any): number {
  const divisor = Number(b) || 1;
  return (Number(a) || 0) / divisor;
}

/**
 * Modulo (remainder)
 * Usage: {{modulo 10 3}} → 1
 */
export function modulo(a: any, b: any): number {
  return (Number(a) || 0) % (Number(b) || 1);
}

/**
 * Absolute value
 * Usage: {{abs -5}} → 5
 */
export function abs(value: any): number {
  return Math.abs(Number(value) || 0);
}

/**
 * Round to nearest integer
 * Usage: {{round 3.7}} → 4
 */
export function round(value: any): number {
  return Math.round(Number(value) || 0);
}

/**
 * Round down (floor)
 * Usage: {{floor 3.7}} → 3
 */
export function floor(value: any): number {
  return Math.floor(Number(value) || 0);
}

/**
 * Round up (ceiling)
 * Usage: {{ceil 3.2}} → 4
 */
export function ceil(value: any): number {
  return Math.ceil(Number(value) || 0);
}

/**
 * Fixed decimal places
 * Usage: {{toFixed 3.14159 2}} → "3.14"
 */
export function toFixed(value: any, decimals: number): string {
  return (Number(value) || 0).toFixed(decimals);
}

/**
 * Convert to integer (parse as int)
 * Usage: {{toInt "42"}} → 42
 * Usage: {{toInt 3.7}} → 3
 */
export function toInt(value: any, radix: number = 10): number {
  return parseInt(String(value), radix) || 0;
}

/**
 * Power (exponentiation)
 * Usage: {{pow 2 3}} → 8
 */
export function pow(base: any, exponent: any): number {
  return Math.pow(Number(base) || 0, Number(exponent) || 0);
}

/**
 * Square root
 * Usage: {{sqrt 16}} → 4
 */
export function sqrt(value: any): number {
  return Math.sqrt(Number(value) || 0);
}

/**
 * Minimum value from arguments
 * Usage: {{min 5 2 8 1}} → 1
 */
export function min(...args: any[]): number {
  const values = args.slice(0, -1).map(v => Number(v) || 0);
  return Math.min(...values);
}

/**
 * Maximum value from arguments
 * Usage: {{max 5 2 8 1}} → 8
 */
export function max(...args: any[]): number {
  const values = args.slice(0, -1).map(v => Number(v) || 0);
  return Math.max(...values);
}

/**
 * Average (mean) of values
 * Usage: {{avg 10 20 30}} → 20
 */
export function avg(...args: any[]): number {
  const values = args.slice(0, -1).map(v => Number(v) || 0);
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Sum of values
 * Usage: {{sum 10 20 30}} → 60
 */
export function sum(...args: any[]): number {
  const values = args.slice(0, -1).map(v => Number(v) || 0);
  return values.reduce((sum, val) => sum + val, 0);
}

/**
 * Random number between 0 and 1
 * Usage: {{random}}
 */
export function random(): number {
  return Math.random();
}

/**
 * Random integer between min and max (inclusive)
 * Usage: {{randomInt 1 10}}
 */
export function randomInt(min: any, max: any): number {
  const minVal = Math.ceil(Number(min) || 0);
  const maxVal = Math.floor(Number(max) || 0);
  return Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
}

/**
 * Clamp value between min and max
 * Usage: {{clamp 15 0 10}} → 10
 */
export function clamp(value: any, min: any, max: any): number {
  const val = Number(value) || 0;
  const minVal = Number(min) || 0;
  const maxVal = Number(max) || 0;
  return Math.min(Math.max(val, minVal), maxVal);
}

/**
 * Percentage calculation
 * Usage: {{percentage 25 200}} → 12.5
 */
export function percentage(value: any, total: any): number {
  const totalNum = Number(total) || 1;
  return ((Number(value) || 0) / totalNum) * 100;
}

/**
 * Format number with thousand separators
 * Usage: {{formatNumber 1234567}} → "1,234,567"
 */
export function formatNumber(value: any, locale: string = 'en-US'): string {
  return (Number(value) || 0).toLocaleString(locale);
}

/**
 * Format as currency
 * Usage: {{currency 1234.56 "USD"}} → "$1,234.56"
 */
export function currency(value: any, currencyCode: string = 'USD', locale: string = 'en-US'): string {
  return (Number(value) || 0).toLocaleString(locale, {
    style: 'currency',
    currency: currencyCode,
  });
}
