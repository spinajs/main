import { domainToASCII } from 'node:url';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-case ASCII (punycode) host name without a trailing dot; null unless it has two or more valid labels and a non-numeric TLD. */
export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().replace(/\.$/, '');
  if (trimmed === '' || trimmed.startsWith('[')) return null;
  const ascii = domainToASCII(trimmed.toLowerCase());
  if (ascii === '' || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])) return null;
  return labels.every((l) => LABEL.test(l)) ? ascii : null;
}

/** The part after the last `@`, normalised as by normalizeDomain. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at < 0 ? null : normalizeDomain(email.slice(at + 1));
}

export function* suffixes(domain: string): Generator<string> {
  yield domain;
  for (let i = domain.indexOf('.'); i >= 0; i = domain.indexOf('.', i + 1)) {
    yield domain.slice(i + 1);
  }
}

export function domainListed(domain: string, listed: ReadonlySet<string>): boolean {
  for (const s of suffixes(domain)) {
    if (listed.has(s)) return true;
  }
  return false;
}
