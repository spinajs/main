import type { DoctorRule } from '../index.js';
import { explicitSchemaDrift } from './explicit-schema-drift.js';

export const DEFAULT_RULES: DoctorRule[] = [explicitSchemaDrift];
