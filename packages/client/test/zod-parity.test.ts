import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { appBasicManifest, corpusManifest } from './support/fixture.js';
import { diagnosticsFor, acceptsOpened, acceptsStripped, explainedBy, parity, parityManifest, serverRefusal, serverVerdict, show, subjectOf, zodSchemaOf, type ParitySubject, type Variant } from './support/parity.js';
import { ajvCoerce } from '../src/formats/index.js';
import { drawInputs, inputsFor, nonFinite, type InputSet } from './support/parity-inputs.js';
import { coercion, core, explicit, gaps, keywords } from './support/parity-schemas.js';
import { clearLoaded } from './support/zod.js';

const SEED = 20261104;
const SAMPLES = 120;

const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let loaded: Promise<T> | undefined;
  return () => (loaded ??= load());
};

const prefixed = (schemas: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [`test/${name}`, schema]));

/**
 * A looser verdict no diagnostic explains, which the owner accepts. It excuses only the inputs `covers` selects on the
 * one schema `schema` (a dedicated schema, one property per gap), and fails the suite where it never fires: the seed is
 * fixed, so a pin that no longer fires is stale. A `code` also requires the schema to carry that diagnostic.
 */
interface Gap {
  schema: string;
  variants: Variant[];
  why: string;
  covers(input: unknown): boolean;
  code?: 'ZOD004';
}

interface Subject {
  name: string;
  load(): Promise<Manifest>;
  gaps: Gap[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Ajv would coerce the value to `type` (it is not one already), as the client's port of its coercion tells. */
const coercesTo = (value: unknown, type: 'number' | 'integer' | 'string'): boolean => {
  const coerced = ajvCoerce(value, [type]);
  return typeof coerced === type.replace('integer', 'number') && coerced !== value;
};

const COERCED_KEYS: Record<string, (input: Record<string, unknown>) => boolean> = {
  'test/GapAnyOfCoerces': (i) => coercesTo(i.v, 'string'),
};

const WHY: Record<string, string> = {
  'test/GapAnyOfCoerces': 'an anyOf member coerces a value that a sibling keyword of the node reads',
};

/** Looser verdicts that `ZOD004` names, each excused only for an input that holds the value Ajv coerces first. */
const GAPS: Gap[] = Object.entries(COERCED_KEYS).map(([schema, coerced]) => ({
  schema,
  variants: ['coerced'],
  code: 'ZOD004',
  why: WHY[schema],
  covers: (input) => isObject(input) && coerced(input),
}));

const gapsOf = (...schemas: string[]): Gap[] => GAPS.filter((g) => schemas.includes(g.schema));

const SUBJECTS: Subject[] = [
  { name: 'app-basic', load: appBasicManifest, gaps: [] },
  { name: 'schema-corpus', load: once(corpusManifest), gaps: [] },
  { name: 'draft-07 core', load: once(async () => parityManifest(await appBasicManifest(), core())), gaps: [] },
  { name: 'draft-07 keywords', load: once(async () => parityManifest(await appBasicManifest(), keywords())), gaps: [] },
  { name: 'explicit keywords', load: once(async () => parityManifest(await appBasicManifest(), explicit(), prefixed(keywords()))), gaps: [] },
  { name: 'coercion', load: once(async () => parityManifest(await appBasicManifest(), coercion())), gaps: [] },
  { name: 'diagnosed gaps and regressions', load: once(async () => parityManifest(await appBasicManifest(), gaps())), gaps: gapsOf(...GAPS.map((g) => g.schema)) },
];

/** Schemas no input satisfies in a variant, so the server accepts none there: the floor does not apply, and none may be accepted. */
const UNSATISFIABLE: Record<string, { variants: Variant[]; why: string }> = {
  'test/CF_allB': { variants: ['request', 'reply'], why: 'a string that is also a number, which only coercion turns one into the other' },
};

/**
 * Schemas whose accepted values are few by the schema itself, with the most the server may accept of the drawn inputs.
 * Every other schema must reach the floor, so a sampler that stops satisfying a keyword fails instead of joining this list.
 */
const SMALL: Record<string, { min?: number; max: number; why: string; variants?: Variant[] }> = {
  'test/Strict3': { max: 19, why: 'one boolean property: absent, true or false' },
  'test/CStatus': { max: 12, why: 'the two strings a and b, and the wire forms of each' },
  'test/CF_allD': { max: 12, why: 'a boolean that must be true' },
  'test/CF_arrOne': { max: 12, why: 'an array of at most one boolean; the wire forms of a coerced query give it more', variants: ['request', 'reply'] },
  'test/CF_c': { max: 12, why: 'the one number 5' },
  'test/CF_constNum': { max: 15, why: 'the one number 0' },
  'test/CF_enumNum': { max: 19, why: 'the integers 1 and 2' },
  'test/CF_flag': { max: 19, why: 'a boolean' },
  'test/CF_kind': { max: 12, why: 'the two strings a and b' },
  'test/CF_n': { max: 15, why: 'null' },
  'test/CF_nullEnum': { max: 15, why: 'a, b or null' },
  'test/RecArray': { min: 10, max: 60, why: 'arrays of arrays only: the shapes are bounded by the node budget that keeps the run short' },
};

/** Schemas whose zod parse costs tens of milliseconds a leaf, so they are drawn fewer random values. */
const LEAN: Record<string, { samples: number; json: number; why: string }> = {
  'test/RecArray': { samples: 60, json: 15, why: 'a coerced recursive array catches a stack overflow per wrapped scalar (guardDepth)' },
};

const FLOOR = 20;
const SERVER = { request: { coerce: false }, coerced: { coerce: true }, reply: { coerce: false } } as const;

interface Fixture extends InputSet {
  verdicts: boolean[];
}

describe('zod parity with the server', function () {
  this.timeout(120000);

  after(clearLoaded);

  const totals: string[] = [];
  const met = new Set<string>();

  after(() => {
    for (const line of totals) console.log(line);
  });

  // The inputs and the server's verdicts do not depend on the zod flavor: drawn once per subject and variant.
  const fixtures = new Map<string, Fixture>();

  const fixtureOf = (subject: ParitySubject, name: string, variant: Variant, id: string, manifest: Manifest): Fixture => {
    const key = `${name} ${variant} ${id}`;
    let fixture = fixtures.get(key);
    if (!fixture) {
      const accepts = (input: unknown): boolean => serverVerdict(subject, id, SERVER[variant], input);
      const set = drawInputs(manifest, id, { coerce: SERVER[variant].coerce, samples: LEAN[id]?.samples ?? SAMPLES, json: LEAN[id]?.json, seed: SEED, accepts, floor: FLOOR });
      fixtures.set(key, (fixture = { ...set, verdicts: set.inputs.map(accepts) }));
    }
    return fixture;
  };

  // A renamed or removed schema must not leave a dead entry behind.
  after(() => {
    const missing = Object.entries(SMALL).flatMap(([id, entry]) => (entry.variants ?? ['request', 'coerced', 'reply']).filter((variant) => !met.has(`${id} ${variant}`)).map((variant) => `${id} ${variant}`));
    expect(missing, 'SMALL entries no schema met').to.deep.equal([]);
  });

  for (const mini of [false, true]) {
    const flavor = mini ? 'mini' : 'classic';

    for (const subject of SUBJECTS) {
      describe(`${subject.name} (${flavor})`, () => {
        let manifest: Manifest;

        before(async () => {
          manifest = await subject.load();
        });

        for (const variant of ['request', 'coerced', 'reply'] as const) {
          it(`${variant}: zod is never stricter, and is looser only where a diagnostic or a pin says so`, async () => {
            const generated = await subjectOf(manifest, mini);
            const options = { ...SERVER[variant], variant, mini };
            const unexplained: string[] = [];
            const thin: string[] = [];
            const pins = subject.gaps.filter((g) => g.variants.includes(variant));
            const fired = new Map<Gap, number>();
            let checked = 0;
            let agree = 0;
            let looser = 0;
            let stricter = 0;
            let thinnest = Number.POSITIVE_INFINITY;
            let saturated = 0;

            for (const id of generated.ids) {
              if (!zodSchemaOf(generated, id, variant)) continue;
              // A schema the server refuses to compile has no verdict to compare; the emitter must say so.
              if (serverRefusal(generated, id, options) !== undefined) {
                expect(diagnosticsFor(generated, id), `${id} is refused by the server`).to.not.have.length(0);
                continue;
              }
              const fixture = fixtureOf(generated, subject.name, variant, id, manifest);
              const result = await parity(manifest, id, { ...options, verdicts: fixture.verdicts }, fixture.inputs);
              checked++;
              agree += result.agree;
              looser += result.zodLooser.length;
              stricter += result.zodStricter.length;
              expect(result.agree + result.zodLooser.length + result.zodStricter.length, `${id} compared nothing`).to.be.greaterThan(0);
              expect(result.errors, `${id} errors`).to.deep.equal([]);
              expect(result.zodStricter.map((d) => show(d.input)).slice(0, 5), `${id} is stricter than the server`).to.deep.equal([]);
              if (UNSATISFIABLE[id]?.variants.includes(variant)) {
                if (result.accepted !== 0) thin.push(`${id}: ${result.accepted} accepted, none expected`);
              } else {
                thinnest = Math.min(thinnest, result.accepted);
                const small = SMALL[id]?.variants?.includes(variant) === false ? undefined : SMALL[id];
                if (small) {
                  saturated++;
                  met.add(`${id} ${variant}`);
                  if (result.accepted < (small.min ?? 1) || result.accepted > small.max) thin.push(`${id}: ${result.accepted} accepted, expected ${small.min ?? 1} to ${small.max}`);
                } else if (result.accepted < FLOOR) thin.push(`${id}: ${result.accepted}`);
              }

              const lost: string[] = [];
              for (const d of result.zodLooser) {
                // A reply takes the keys it does not declare: the server with its closed objects opened accepts the input, or the reply only dropped undeclared keys and the server accepts the rest.
                if (variant === 'reply' && (acceptsOpened(generated, id, SERVER.reply, d.input) || acceptsStripped(generated, id, SERVER.reply, d.input, d.output))) continue;
                if (explainedBy(generated, id, SERVER[variant], d.input)) continue;
                const pin = pins.find((g) => g.schema === id && g.covers(d.input));
                if (pin) {
                  fired.set(pin, (fired.get(pin) ?? 0) + 1);
                  if (pin.code) expect(generated.diagnostics.filter((x) => x.schema === id && x.code === pin.code), `${id} has no ${pin.code}`).to.not.have.length(0);
                } else lost.push(show(d.input));
              }
              if (lost.length > 0) unexplained.push(`${id}: ${lost.sort((a, b) => a.length - b.length).slice(0, 5).join('  ')}`);
            }

            totals.push(`parity ${subject.name} ${flavor} ${variant}: ${checked} schemas, agree ${agree}, zod looser ${looser}, zod stricter ${stricter}, fewest accepted ${thinnest}, ${saturated} with few values to accept`);
            expect(checked, 'schemas compared').to.be.greaterThan(0);
            const stale = pins.filter((g) => !fired.has(g)).map((g) => g.schema);
            expect({ thin, unexplained, stale }, `thin: schemas with fewer than ${FLOOR} inputs the server accepts; unexplained: looser than the server with no diagnostic or pin to say why; stale: pins no input exercised`).to.deep.equal({ thin: [], unexplained: [], stale: [] });
          });
        }
      });
    }
  }

  describe('non-finite numbers, as code can build them', () => {
    for (const mini of [false, true]) {
      it(`zod never accepts less than the server does (${mini ? 'mini' : 'classic'})`, async () => {
        const manifest = parityManifest(await appBasicManifest(), { ...core(), ...keywords(), ...coercion() });
        const generated = await subjectOf(manifest, mini);
        for (const variant of ['request', 'coerced'] as const) {
          for (const id of generated.ids) {
            if (!zodSchemaOf(generated, id, variant) || serverRefusal(generated, id, SERVER[variant]) !== undefined) continue;
            const result = await parity(manifest, id, { ...SERVER[variant], variant, mini }, nonFinite());
            expect(result.zodStricter.map((d) => show(d.input)), `${variant} ${id}`).to.deep.equal([]);
            expect(result.errors, `${variant} ${id} errors`).to.deep.equal([]);
          }
        }
      });
    }
  });

  describe('the harness', () => {
    const manifest = async () =>
      parityManifest(await appBasicManifest(), {
        Page: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
        Loose: { type: 'object', properties: { a: { type: 'string' }, b: {} }, anyRequired: ['a', 'b'] },
        Both: { type: 'object', properties: { a: {}, b: {} }, required: ['a'], anyRequired: ['a', 'b'] },
      });

    it('reports an input zod refuses and the server accepts as zodStricter', async () => {
      // The server coerces '5' to an integer; the request schema takes only numbers.
      const result = await parity(await manifest(), 'test/Page', { coerce: true, variant: 'request' }, [{ n: '5' }, { n: 5 }, { n: 'x' }]);
      expect(result.zodStricter.map((d) => d.input)).to.deep.equal([{ n: '5' }]);
      expect(result.agree).to.equal(2);
      expect(result.zodLooser).to.deep.equal([]);
    });

    it('reports an input zod accepts and the server refuses as zodLooser, when a keyword is dropped', async () => {
      const m = await manifest();
      const result = await parity(m, 'test/Loose', { coerce: false }, [{}, { a: 'x' }]);
      expect(result.zodLooser.map((d) => d.input)).to.deep.equal([{}]);
      expect(diagnosticsFor(await subjectOf(m), 'test/Loose').map((d) => d.code)).to.deep.equal(['ZOD003']);
    });

    it('explains a looser verdict only by the keyword a diagnostic names', async () => {
      const subject = await subjectOf(await manifest());
      const options = { coerce: false };
      expect(explainedBy(subject, 'test/Loose', options, {})).to.equal(true);
      // Without anyRequired the server still refuses {}: required is the reason, and no diagnostic names it.
      expect(explainedBy(subject, 'test/Both', options, {})).to.equal(false);
      expect(explainedBy(subject, 'test/Page', options, {})).to.equal(false);
    });

    it('tops the accepted inputs up to the floor and mutates an accepted object one property at a time', async () => {
      const m = await manifest();
      const subject = await subjectOf(m);
      const accepts = (input: unknown): boolean => serverVerdict(subject, 'test/Page', { coerce: false }, input);
      const { inputs } = drawInputs(m, 'test/Page', { coerce: false, samples: 5, seed: 1, accepts, floor: 8 });
      expect(new Set(inputs.filter(accepts).map((v) => JSON.stringify(v))).size).to.be.at.least(8);
      expect(inputs.some((v) => typeof v === 'object' && v !== null && !('n' in v) && Object.keys(v).length === 0)).to.equal(true);
    });

    it('excuses a reply only for the undeclared keys it dropped', async () => {
      const subject = await subjectOf(await manifest());
      const options = { coerce: false };
      expect(acceptsStripped(subject, 'test/Page', options, { n: 1, zz: 1 }, { n: 1 })).to.equal(true);
      // The reply forgot a declared property: the key is gone, and what is left is valid.
      expect(acceptsStripped(subject, 'test/Loose', options, { a: 'x', b: 1, c: 1 }, { a: 'x', c: 1 })).to.equal(false);
      expect(acceptsStripped(subject, 'test/Page', options, { n: 1 }, { n: 1 })).to.equal(false);
    });

    it('keeps the small-domain list named and bounded', () => {
      expect(Object.keys(SMALL).sort()).to.deep.equal([
        'test/CF_allD', 'test/CF_arrOne', 'test/CF_c', 'test/CF_constNum', 'test/CF_enumNum', 'test/CF_flag', 'test/CF_kind', 'test/CF_n', 'test/CF_nullEnum', 'test/CStatus', 'test/RecArray', 'test/Strict3',
      ]);
      expect(Object.entries(SMALL).filter(([, v]) => v.max >= FLOOR).map(([id]) => id)).to.deep.equal(['test/RecArray']);
    });

    it('draws the same inputs for the same seed, and different ones for another', async () => {
      const m = await manifest();
      const draw = (seed: number) => JSON.stringify(inputsFor(m, 'test/Page', { coerce: true, samples: 50, seed }));
      expect(draw(1)).to.equal(draw(1));
      expect(draw(1)).to.not.equal(draw(2));
    });
  });
});
