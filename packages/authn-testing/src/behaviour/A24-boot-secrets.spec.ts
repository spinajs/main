import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A24: AuthnRule = defineRule('A24', 'secrets refuse public or missing values outside development and test', []);
