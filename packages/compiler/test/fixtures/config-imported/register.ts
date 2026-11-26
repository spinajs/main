import type * as Imported from './dep/index.js';
import { IMPORTED_CONFIGURATION_SCHEMA } from './dep/index.js';
import { THIRD_SCHEMA } from './third-party/index.js';
import { BARRELLED, REEXPORTED } from './barrel.js';

declare function registerConfigurationSchema(schema: unknown): void;
declare function makeSchema(): object;
declare const imported: typeof Imported;
declare const holder: Imported.SchemaHolder;

// a dependency's schema (its package ships a fragment), through a lazily imported namespace, a named import and an own barrel
registerConfigurationSchema(imported.IMPORTED_CONFIGURATION_SCHEMA);
registerConfigurationSchema(IMPORTED_CONFIGURATION_SCHEMA);
registerConfigurationSchema(REEXPORTED);

// schemas no build reads: built at run time, typed by a dependency, declared by this package or by a package without a fragment
const OWN = makeSchema();
registerConfigurationSchema(OWN);
registerConfigurationSchema(holder.schema);
registerConfigurationSchema(AMBIENT_SCHEMA);
registerConfigurationSchema(BARRELLED);
registerConfigurationSchema(THIRD_SCHEMA);
