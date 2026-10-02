import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A15: AuthnRule = defineRule('A15', 'agent tokens act for their owner inside a ceiling', []);
