// Backward-compat shim: the variable classes + `format` machinery were split
// into platform-free ( variables-common ) and Node-only ( variables-node )
// modules so the package can ship a browser entry. This file preserves the
// historical `./variables.js` import path used by tests and downstream code.
export * from './variables-common.js';
export * from './variables-node.js';
