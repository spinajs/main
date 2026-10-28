export const a = join(root, 'lib', typeof module !== 'undefined' ? 'cjs' : 'mjs', 'config');
export const b = typeof module !== 'undefined' ? 'lib/cjs' : 'lib/mjs';
export const c = typeof module === 'undefined' ? 'lib/mjs/x' : 'lib/cjs/x';
export const d = typeof module !== 'undefined' ? require('./a.cjs') : import('./a.js');
