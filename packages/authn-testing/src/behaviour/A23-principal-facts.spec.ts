import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A23: AuthnRule = defineRule('A23', 'a success becomes a principal with authn facts', []);
