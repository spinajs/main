import type * as Imported from './schema.js';
import { IMPORTED_CONFIGURATION_SCHEMA } from './schema.js';

declare function registerConfigurationSchema(schema: unknown): void;
declare function makeSchema(): object;
declare const imported: typeof Imported;
declare const holder: Imported.SchemaHolder;

// another package's schema, through a lazily imported namespace and through a named import: its own fragment records it
registerConfigurationSchema(imported.IMPORTED_CONFIGURATION_SCHEMA);
registerConfigurationSchema(IMPORTED_CONFIGURATION_SCHEMA);

// this package's schemas, built at run time: the build cannot read them, although the second one's type is declared elsewhere
const OWN = makeSchema();
registerConfigurationSchema(OWN);
registerConfigurationSchema(holder.schema);
