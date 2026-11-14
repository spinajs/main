declare module 'pg/lib/utils' {
  const utils: { prepareValue(value: unknown): unknown };
  export default utils;
}
