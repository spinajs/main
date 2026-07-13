// Browser entry: same public surface as index.ts MINUS variables-node
// ( which imports os / path / crypto and is therefore Node-only ).
export * from './definitions.js';
export * from './variables-common.js';
export * from './static-source.js';
