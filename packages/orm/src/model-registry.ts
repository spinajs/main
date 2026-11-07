import type { ModelBase } from './model.js';

type ModelBaseClass = abstract new (...args: never[]) => ModelBase;

// hydrators.ts recognises model instances through this instead of importing model.ts, which imports the hydrators.
let modelBase: ModelBaseClass | undefined;

export function registerModelBase(type: ModelBaseClass): void {
  modelBase = type;
}

export function isModel(value: unknown): value is ModelBase {
  return modelBase !== undefined && value instanceof modelBase;
}
