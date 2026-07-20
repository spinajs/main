// This fixture intentionally has NO default export.
// FileSystemSource must warn and skip it, without breaking loading of the
// other schemas in this directory.
export const notASchema = {
  $id: 'http://spinajs/should_not_be_loaded.schema.mjs',
  type: 'object',
};
