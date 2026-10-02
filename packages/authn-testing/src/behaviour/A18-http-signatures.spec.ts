import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A18: AuthnRule = defineRule('A18', 'HTTP signatures cover method, target and digest, once', []);
