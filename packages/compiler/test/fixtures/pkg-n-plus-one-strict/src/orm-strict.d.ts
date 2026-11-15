import '@spinajs/orm';

declare module '@spinajs/orm' {
  interface OrmTypeRegistry {
    strictColumns: true;
  }
}
