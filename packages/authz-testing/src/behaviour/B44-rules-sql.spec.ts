import { fixture } from './dsl.js';

export const B44 = fixture('B44', [
  {
    name: 'retired',
    facets: ['engine'],
    lanes: ['L5'],
    note: 'Retired with query rewriting (design 2026-10-14 §9): RBAC rules are check-only, and boot rule 12 refuses a list: true permission on a type with a cap, restrict or threshold rule.',
    cases: [],
  },
]);
