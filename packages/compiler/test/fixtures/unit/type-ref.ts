import type { DateTime } from 'luxon';
import type { Container } from '@spinajs/di';

export class Exported { public id!: number }
class Hidden { public id!: number }
export enum Color { Red = 'red', Blue = 'blue' }
export enum Level { Low, High }
export interface Shape { id: number }

export function runtimeTypes(
  num: number,
  exported: Exported,
  hidden: Hidden,
  color: Color,
  level: Level,
  shape: Shape,
  date: Date,
  literal: 'a' | 'b',
  list: Exported[],
  flag: boolean | undefined,
  loose: any,
  nullable: Exported | null,
  mixed: string | number,
  foreign: Container,
  untracked: DateTime,
  bytes: Uint8Array,
): void {
  void [num, exported, hidden, color, level, shape, date, literal, list, flag, loose, nullable, mixed, foreign, untracked, bytes];
}

export function ambient(storage: import('node:async_hooks').AsyncLocalStorage<number>): void {
  void storage;
}

export function documented(buffer: Buffer, big: bigint, sym: symbol, tuple: [string, number], nothing: null, undef: undefined, callback: () => void): void {
  void [buffer, big, sym, tuple, nothing, undef, callback];
}

export abstract class AbstractExported {}

export declare class DeclaredOnly {}

declare global {
  class AmbientGlobal {}
}

export function notValues(_cls: typeof Exported, _abstract: typeof AbstractExported, _element: HTMLElement, _ambient: AmbientGlobal, _declared: DeclaredOnly, _instance: Exported) {}
