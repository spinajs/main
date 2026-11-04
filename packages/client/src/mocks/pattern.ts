import type { Rng } from './rng.js';

type Range = readonly [number, number];

/** A regex in the sampled subset: literals, classes, quantifiers, groups, alternation and anchors. */
export type PatternNode =
  | { kind: 'seq'; items: PatternNode[] }
  | { kind: 'alt'; options: PatternNode[] }
  | { kind: 'set'; ranges: Range[] }
  | { kind: 'repeat'; node: PatternNode; min: number; max: number }
  | { kind: 'start' }
  | { kind: 'end' };

// Negated sets are sampled from printable ASCII; a set with nothing left there is outside the subset.
const PRINTABLE: Range = [0x20, 0x7e];
const DIGIT: Range[] = [[0x30, 0x39]];
const WORD: Range[] = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
const SPACE: Range[] = [[0x09, 0x0d], [0x20, 0x20]];
const SYNTAX = new Set('^$\\.*+?()[]{}|/');
const CONTROL: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, f: 0x0c, v: 0x0b };
const UNBOUNDED_EXTRA = 3;

class Outside extends Error {}

function complement(ranges: Range[]): Range[] {
  const out: Range[] = [];
  let next = PRINTABLE[0];
  for (const [lo, hi] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (lo > next) out.push([next, Math.min(lo - 1, PRINTABLE[1])]);
    next = Math.max(next, hi + 1);
  }
  if (next <= PRINTABLE[1]) out.push([next, PRINTABLE[1]]);
  return out.filter(([lo, hi]) => lo <= hi && lo <= PRINTABLE[1]);
}

const set = (ranges: Range[]): PatternNode => {
  if (ranges.length === 0) throw new Outside();
  return { kind: 'set', ranges };
};

class Parser {
  private at = 0;
  private readonly chars: string[];

  constructor(source: string) {
    this.chars = [...source];
  }

  public parse(): PatternNode {
    const node = this.alternation();
    if (this.at < this.chars.length) throw new Outside();
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.chars[this.at + offset];
  }

  private take(): string {
    const c = this.chars[this.at++];
    if (c === undefined) throw new Outside();
    return c;
  }

  private alternation(): PatternNode {
    const options = [this.sequence()];
    while (this.peek() === '|') {
      this.at++;
      options.push(this.sequence());
    }
    return options.length === 1 ? options[0] : { kind: 'alt', options };
  }

  private sequence(): PatternNode {
    const items: PatternNode[] = [];
    while (this.peek() !== undefined && this.peek() !== '|' && this.peek() !== ')') items.push(this.quantified(this.atom()));
    return { kind: 'seq', items };
  }

  private atom(): PatternNode {
    const c = this.take();
    if (c === '^') return { kind: 'start' };
    if (c === '$') return { kind: 'end' };
    if (c === '(') return this.group();
    if (c === '[') return this.characterClass();
    if (c === '.') return set([PRINTABLE]);
    if (c === '\\') return this.escape(false);
    if ('*+?{}])'.includes(c)) throw new Outside();
    const code = c.codePointAt(0)!;
    return set([[code, code]]);
  }

  private group(): PatternNode {
    if (this.peek() === '?') {
      this.at++;
      const kind = this.take();
      if (kind === '<' && /[A-Za-z_$]/.test(this.peek() ?? '')) {
        while (this.peek() !== '>') if (!/[\w$]/.test(this.take())) throw new Outside();
        this.at++;
      } else if (kind !== ':') {
        throw new Outside();
      }
    }
    const node = this.alternation();
    if (this.take() !== ')') throw new Outside();
    return node;
  }

  private quantified(node: PatternNode): PatternNode {
    const c = this.peek();
    let bounds: [number, number] | undefined;
    if (c === '*') bounds = [0, Infinity];
    else if (c === '+') bounds = [1, Infinity];
    else if (c === '?') bounds = [0, 1];
    if (bounds) this.at++;
    else if (c === '{') bounds = this.braces();
    if (!bounds) return node;
    if (node.kind === 'start' || node.kind === 'end') throw new Outside();
    if (this.peek() === '?') this.at++;
    return { kind: 'repeat', node, min: bounds[0], max: bounds[1] };
  }

  private braces(): [number, number] {
    const rest = this.chars.slice(this.at).join('');
    const match = /^\{(\d+)(,(\d*))?\}/.exec(rest);
    if (!match) throw new Outside();
    this.at += [...match[0]].length;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
    if (max < min || min > 1000) throw new Outside();
    return [min, max];
  }

  private escape(inClass: boolean): PatternNode {
    const ranges = this.escapeRanges(inClass);
    return set(ranges);
  }

  private escapeRanges(inClass: boolean): Range[] {
    const c = this.take();
    const classes: Record<string, Range[]> = { d: DIGIT, D: complement(DIGIT), w: WORD, W: complement(WORD), s: SPACE, S: complement(SPACE) };
    if (Object.hasOwn(classes, c)) return classes[c];
    const code = this.escapeCode(c, inClass);
    return [[code, code]];
  }

  private escapeCode(c: string, inClass: boolean): number {
    if (Object.hasOwn(CONTROL, c)) return CONTROL[c];
    if (SYNTAX.has(c) || (inClass && c === '-')) return c.codePointAt(0)!;
    if (inClass && c === 'b') return 0x08;
    if (c === '0' && !/\d/.test(this.peek() ?? '')) return 0;
    if (c === 'x') return this.hex(2);
    if (c === 'u') {
      if (this.peek() !== '{') return this.hex(4);
      this.at++;
      const code = this.hex(0);
      if (this.take() !== '}' || code > 0x10ffff) throw new Outside();
      return code;
    }
    throw new Outside();
  }

  private hex(digits: number): number {
    let text = '';
    while ((digits === 0 || text.length < digits) && /[0-9a-fA-F]/.test(this.peek() ?? '')) text += this.take();
    if (text.length === 0 || (digits > 0 && text.length !== digits)) throw new Outside();
    return parseInt(text, 16);
  }

  private characterClass(): PatternNode {
    const negated = this.peek() === '^';
    if (negated) this.at++;
    const ranges: Range[] = [];
    while (this.peek() !== ']') {
      const lo = this.classAtom();
      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
        this.at++;
        const hi = this.classAtom();
        if (lo.length !== 1 || hi.length !== 1 || lo[0][0] !== lo[0][1] || hi[0][0] !== hi[0][1] || hi[0][0] < lo[0][0]) throw new Outside();
        ranges.push([lo[0][0], hi[0][0]]);
      } else {
        ranges.push(...lo);
      }
    }
    this.at++;
    return set(negated ? complement(ranges) : ranges);
  }

  private classAtom(): Range[] {
    const c = this.take();
    if (c === '\\') return this.escapeRanges(true);
    if (c === '[') throw new Outside();
    const code = c.codePointAt(0)!;
    return [[code, code]];
  }
}

// Anchors are honoured only where they cannot fail: `^` first and `$` last in a top-level alternative.
function anchorsInPlace(root: PatternNode): boolean {
  const alternatives = root.kind === 'alt' ? root.options : [root];
  const inside = (node: PatternNode): boolean => {
    if (node.kind === 'start' || node.kind === 'end') return true;
    if (node.kind === 'seq') return node.items.some(inside);
    if (node.kind === 'alt') return node.options.some(inside);
    return node.kind === 'repeat' && inside(node.node);
  };
  return alternatives.every((alt) => {
    const items = alt.kind === 'seq' ? alt.items : [alt];
    return items.every((item, i) => {
      if (item.kind === 'start') return i === 0;
      if (item.kind === 'end') return i === items.length - 1;
      return !inside(item);
    });
  });
}

/** The pattern as a tree, or `undefined` when it is outside the sampled subset or not a valid `u`-flag regex. */
export function parsePattern(source: string): PatternNode | undefined {
  try {
    new RegExp(source, 'u');
    const node = new Parser(source).parse();
    return anchorsInPlace(node) ? node : undefined;
  } catch {
    return undefined;
  }
}

/** Whether every top-level alternative ends with `$`, so text appended after a match would break it. */
export function endsAnchored(node: PatternNode): boolean {
  const alternatives = node.kind === 'alt' ? node.options : [node];
  return alternatives.some((alt) => alt.kind === 'end' || (alt.kind === 'seq' && alt.items.at(-1)?.kind === 'end'));
}

function minLength(node: PatternNode): number {
  switch (node.kind) {
    case 'seq':
      return node.items.reduce((sum, item) => sum + minLength(item), 0);
    case 'alt':
      return Math.min(...node.options.map(minLength));
    case 'set':
      return 1;
    case 'repeat':
      return node.min * minLength(node.node);
    default:
      return 0;
  }
}

function pickCode(ranges: Range[], rng: Rng): number {
  const total = ranges.reduce((sum, [lo, hi]) => sum + hi - lo + 1, 0);
  let n = rng.int(0, total - 1);
  for (const [lo, hi] of ranges) {
    if (n <= hi - lo) return lo + n;
    n -= hi - lo + 1;
  }
  return ranges[0][0];
}

interface Budget {
  /** Code points still to add beyond the minimum; undefined when no length is aimed at. */
  extra?: number;
}

function repeats(node: Extract<PatternNode, { kind: 'repeat' }>, rng: Rng, budget: Budget): number {
  if (budget.extra === undefined) return rng.int(node.min, Math.min(node.max, node.min + UNBOUNDED_EXTRA));
  if (budget.extra <= 0) return node.min;
  const unit = Math.max(1, minLength(node.node));
  const more = Math.min(node.max - node.min, Math.ceil(budget.extra / unit));
  budget.extra -= more * unit;
  return node.min + more;
}

function generate(node: PatternNode, rng: Rng, budget: Budget): string {
  switch (node.kind) {
    case 'seq':
      return node.items.map((item) => generate(item, rng, budget)).join('');
    case 'alt':
      return generate(rng.pick(node.options), rng, budget);
    case 'set':
      return String.fromCodePoint(pickCode(node.ranges, rng));
    case 'repeat': {
      let out = '';
      for (let i = repeats(node, rng, budget); i > 0; i--) out += generate(node.node, rng, budget);
      return out;
    }
    default:
      return '';
  }
}

/**
 * A string the pattern matches. With `length`, quantifiers stretch towards that many code points; without it, each
 * unbounded quantifier repeats at most 3 times beyond its minimum.
 */
export function samplePattern(node: PatternNode, rng: Rng, length?: number): string {
  return generate(node, rng, { extra: length === undefined ? undefined : length - minLength(node) });
}
