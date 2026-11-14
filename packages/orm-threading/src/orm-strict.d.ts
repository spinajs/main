// Strict query typing for this package only: tsc does not emit .d.ts inputs, so consumers keep their own mode.
export {};

declare module '@spinajs/orm' {
  interface OrmTypeRegistry {
    strictColumns: true;
  }
}
