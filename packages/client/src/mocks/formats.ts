import type { Rng } from './rng.js';

/** Gives a value of the format, at least `minLength` code points long where the format can stretch. */
export type FormatSampler = (rng: Rng, minLength: number) => string;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const ALPHANUMERIC = `${LETTERS}0123456789`;
const HEX = '0123456789abcdef';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function chars(rng: Rng, alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[rng.int(0, alphabet.length - 1)];
  return out;
}

/** A lowercase word starting with a letter, `max(n, 1)` long. */
export function word(rng: Rng, n: number): string {
  return chars(rng, LETTERS, 1) + chars(rng, ALPHANUMERIC, Math.max(n, 1) - 1);
}

const two = (n: number): string => String(n).padStart(2, '0');
const date = (rng: Rng): string => `${rng.int(1970, 2037)}-${two(rng.int(1, 12))}-${two(rng.int(1, 28))}`;
const time = (rng: Rng): string => `${two(rng.int(0, 23))}:${two(rng.int(0, 59))}:${two(rng.int(0, 59))}Z`;

// Host labels are at most 63 characters, so a long host name is several labels.
function host(rng: Rng, n: number): string {
  const labels: string[] = [];
  for (let left = Math.max(n, 3); left > 0; left -= 61) labels.push(word(rng, Math.min(left, 60)));
  return labels.join('.');
}

function base64(rng: Rng, minLength: number): string {
  const groups = Math.max(1, Math.ceil(minLength / 4));
  return chars(rng, BASE64, groups * 4 - 2) + (rng.chance() ? '==' : `${chars(rng, BASE64, 1)}=`);
}

function decimal(rng: Rng, minLength: number): string {
  const integer = String(rng.int(1, 9)) + chars(rng, '0123456789', Math.max(0, minLength - 4));
  return `${integer}.${chars(rng, '0123456789', 2)}`;
}

/** One sampler per string format `formatPredicate` knows: the ajv-formats 2.1.1 list and `decimal`. */
export const FORMAT_SAMPLERS: Readonly<Record<string, FormatSampler>> = {
  date,
  time,
  'date-time': (rng) => `${date(rng)}T${time(rng)}`,
  duration: (rng) => rng.pick([`P${rng.int(1, 30)}D`, `PT${rng.int(1, 23)}H${rng.int(1, 59)}M`, `P${rng.int(1, 9)}Y${rng.int(1, 11)}M`, `P${rng.int(1, 52)}W`]),
  uri: (rng, min) => `https://example.com/${word(rng, min - 20)}`,
  'uri-reference': (rng, min) => `/items/${word(rng, min - 7)}`,
  'uri-template': (rng, min) => `https://example.com/${word(rng, min - 25)}/{id}`,
  url: (rng, min) => `https://example.com/${word(rng, min - 20)}`,
  email: (rng, min) => `${word(rng, min - 12)}@example.com`,
  hostname: (rng, min) => `${host(rng, min - 12)}.example.com`,
  ipv4: (rng) => `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
  ipv6: (rng) => `2001:db8:${chars(rng, HEX, 4)}:${chars(rng, HEX, 4)}::${chars(rng, HEX, 4)}`,
  regex: (rng, min) => `^${word(rng, min - 2)}$`,
  uuid: (rng) => `${chars(rng, HEX, 8)}-${chars(rng, HEX, 4)}-4${chars(rng, HEX, 3)}-${rng.pick(['8', '9', 'a', 'b'])}${chars(rng, HEX, 3)}-${chars(rng, HEX, 12)}`,
  'json-pointer': (rng, min) => `/${word(rng, min - 3)}/${rng.int(0, 9)}`,
  'json-pointer-uri-fragment': (rng, min) => `#/${word(rng, min - 4)}/${rng.int(0, 9)}`,
  'relative-json-pointer': (rng, min) => `${rng.int(0, 9)}/${word(rng, min - 2)}`,
  byte: base64,
  password: (rng, min) => word(rng, Math.max(min, 12)),
  binary: (rng, min) => word(rng, Math.max(min, 8)),
  decimal,
};
