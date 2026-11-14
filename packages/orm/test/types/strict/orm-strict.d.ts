export {};

declare module '@spinajs/orm' {
  interface OrmTypeRegistry {
    strictColumns: true;
  }
}
