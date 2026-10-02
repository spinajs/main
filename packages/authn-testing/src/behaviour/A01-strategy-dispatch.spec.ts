import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A01: AuthnRule = defineRule('A01', 'credentials go to the listed strategy for their kind', []);
