import { DateTime } from 'luxon';
import { Readable, Stream } from 'node:stream';
import { Schema } from './decorators-shim.js';
import * as zod4 from './vendor/zod4/index.js';
import * as zod3 from './vendor/zod3/index.js';
import * as valibot from './vendor/valibot/index.js';
import * as zod325v4 from './vendor/zod325/v4/index.js';

// --- primitives and literals (Task 2)
export type PString = string;
export type PNumber = number;
export type PBoolean = boolean;
export type PBigint = bigint;
export type PNull = null;
export type LStr = 'a';
export type LNum = 1;
export type LBool = true;
export type LUnion = 'a' | 'b';
export type LNumUnion = 1 | 2;
export enum Color { Red = 'red', Blue = 'blue' }
export enum Level { Low, High }

// --- arrays and tuples (Task 3)
export type AStr = string[];
export type AGeneric = Array<number>;
export type AReadonly = readonly string[];
export type ANested = string[][];
export type TPair = [string, number];
export type TOptional = [string, number?];
export type TRest = [string, ...number[]];

// --- unions and intersections (Task 4)
export interface Point { x: number; y: number }
export type UNullable = string | null;
export type UOptionalUndef = string | undefined;
export type UMixed = string | number;
export type UObjNull = Point | null;
export type UBoolOrStr = boolean | 'auto';
export interface Circle { kind: 'circle'; r: number }
export interface Square { kind: 'square'; side: number }
export type Shape = Circle | Square;
export interface A { a: string }
export interface B { b: number }
export type IAB = A & B;

// --- objects (Task 5)
export interface OOptional { a: string; b?: number }
export interface OReadonly { readonly id: number }
export interface OMethods { a: string; run(): void; cb: () => void }
export interface OIndex { [key: string]: number }
export type ORecord = Record<string, boolean>;
export type OLiteral = { a: string };
export class CDto {
  public a: string;
  public b?: number;
  constructor(data: Partial<CDto>) { Object.assign(this, data); }
  public toString(): string { return this.a; }
}

// --- utility types (Task 6)
export type UPartial = Partial<Point>;
export type UPick = Pick<Point, 'x'>;
export type UOmit = Omit<Point, 'x'>;
export type URequired = Required<OOptional>;

// --- well-known (Task 7)
export type WDate = Date;
export type WDateTime = DateTime;
export type WBuffer = Buffer;
export type WU8 = Uint8Array;
export type WF32 = Float32Array;
export type WReadable = Readable;
export type WStream = Stream;

// --- generics and naming (Task 8)
export interface Page<T> { items: T[]; total: number }
export type GPage = Page<Point>;
export type GNested = Page<Page<Point>>;

// --- recursion (Task 9)
export interface Tree { value: number; children: Tree[] }
export type Deep = { a: { b: { c: { d: string } } } };

// --- unsupported (Task 10)
export type XAny = any;
export type XUnknown = unknown;
export type XObject = object;
export type XFn = () => void;
export type XSymbol = symbol;
export type XNever = never;
export type XVoid = void;

// --- JSDoc (Task 11)
export interface JDoc {
  /**
   * The display name
   * @minLength 1
   * @maxLength 10
   */
  name: string;
  /**
   * @minimum 0
   * @maximum 100
   * @default 50
   */
  score: number;
  /**
   * @pattern ^[a-z]+$
   * @format email
   */
  email: string;
  /** @example 2020-01-01 */
  when: string;
  /** @deprecated */
  old?: string;
  /**
   * @minItems 1
   * @uniqueItems
   */
  tags: string[];
}

// --- explicit @Schema (Task 12)
export const EXPLICIT_SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
@Schema(EXPLICIT_SCHEMA)
export class ExplicitDto { public a: string; public b: number }
@Schema({ $id: 'fixture/custom-id', type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] })
export class ExplicitWithIdDto { public a: string; public b: number }
@Schema('fixture/by-ref')
export class ExplicitRefDto { public a: string }

// --- explicit @Schema the analyzer cannot fully evaluate
const helperBody = (): object => ({ type: 'object', properties: { a: { type: 'string' } } });
function buildSchema(): object {
  return { type: 'object' };
}
const KEYS = ['a', 'b'] as const;
const KEY = 'a';
@Schema({ ...helperBody(), description: 'spread of a call' })
export class ExplicitSpreadDto { public a: string; public b?: number }
@Schema({ type: 'object', description: 'mapped', anyOf: KEYS.map((k) => ({ required: [k] })) })
export class ExplicitMappedDto { public a?: string; public b?: number }
@Schema(buildSchema())
export class ExplicitCallDto { public a: string }
@Schema({ type: 'object', properties: { [KEY]: { type: 'string' } }, required: [KEY] })
export class ExplicitComputedKeyDto { public a: string }
@Schema({ type: 'object', properties: { [helperBody.name]: { type: 'string' } } })
export class ExplicitUnknownKeyDto { public a: string }

// --- review fixes
export interface OUndef { x: number | undefined; y: string }
export class CUndef { public x!: number | undefined; public z: string }
export interface OAnyIndex { [key: string]: any }
@Schema('fixture/by-ref-with-body')
export class ExplicitRefNested { public inner: Point }
export namespace Other { export interface Point { z: string } }
export interface Collide { a: Point; b: Other.Point }

// --- template literal types
export type TPrefix = `native:${string}`;
export type TSuffix = `${string}.json`;
export type TInfix = `a${string}b${string}c`;
export type TNumber = `v${number}`;
export type TUpper = Uppercase<string>;

// --- recursive aliases
export type RFilter = { op: 'not'; arg: RFilter } | { op: 'and'; args: readonly RFilter[] } | { op: 'leaf'; field: string };
export interface RHolder { filter: RFilter; again: RFilter }
export type OFilter = { op: 'not'; arg?: OFilter } | { op: 'leaf'; field: string };
export type NFilter = { op: 'not'; arg: NFilter | null } | { op: 'leaf'; field: string };
export interface OHolder { filter: OFilter; maybe?: OFilter; nullable: NFilter | null }

// --- class member visibility
export class CVisibility {
  public a: string;
  protected b: any;
  private c: number;
  #d = 1;
  constructor(protected e?: string) {}
}

// --- generic arguments in hoisted names
export interface Dict<T> { [key: string]: T }
export type DRec<T> = { value: T; next: DRec<T> } | { end: true };
export interface DHolder { a: Dict<string>; b: Dict<string[]>; c: Dict<[string, number]>; d: DRec<string>; e: DRec<string[]> }

// --- Standard Schema (C9)
@Schema(zod4.object({ name: 'string' }))
export class StdZodExportedDto { public name: string; public extra?: number }
export const StdZodExportedDtoJsonSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };
@Schema(zod4.object({ name: 'string' }))
export class StdZodMissingDto { public name: string }
@Schema(zod4.object({ name: 'string' }))
export class StdZodCallDto { public name: string }
export const StdZodCallDtoJsonSchema = buildSchema();
@Schema(zod3.object({ name: 'string' }))
export class StdZod3Dto { public name: string }
export const StdZod3DtoJsonSchema = { type: 'object' };
@Schema(valibot.object({ name: 'string' }))
export class StdOtherDto { public name: string }
@Schema(zod325v4.object({ name: 'string' }))
export class StdZodV4SubpathDto { public name: string }
export const StdZodV4SubpathDtoJsonSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };
interface LocalStandard { readonly '~standard': { readonly version: 1; readonly vendor: 'my-lib'; readonly validate: (value: unknown) => { value: unknown } } }
declare const localStandard: LocalStandard;
@Schema(localStandard)
export class StdLocalDto { public name: string }
