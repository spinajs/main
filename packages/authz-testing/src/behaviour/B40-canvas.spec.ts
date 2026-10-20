import { fixture } from './dsl.js';

// A stub: K1 owns packages/authz-testing/{test,fixtures}/canvas-c6/** and runs the vendored canvas
// cases there (plan §1 rule 4). These parts name what its acceptance covers; each note says how K1
// fills the part.
export const B40 = fixture('B40', [
  {
    name: 'memory',
    facets: ['canvas'],
    lanes: ['K1'],
    note: 'K1 task 6: the 62 cases of cases.json plus the 2 r3 cases of extra-cases.json (64) through the C6 facade over the design §8.5 config and the state.json scope resolver, in memory. K1 fills it: a FixtureExtension with the same id and part name, written in test/canvas-c6/ and passed through runBehaviour(…, { fixtures: [...BEHAVIOUR_FIXTURES, ext] }), replaces this empty part (mergeFixtures); K1 declares its canvas handle by augmenting LaneHandles there.',
    cases: [],
  },
  {
    name: 'sqlite',
    facets: ['canvas', 'admin', 'store', 'sql'],
    lanes: ['K1'],
    note: 'K1 task 7: the same 64 cases with state.json written through AuthzAdmin into the authz tables on SQLite. K1 fills it: a FixtureExtension with the same id and part name, written in test/canvas-c6/ and passed through runBehaviour(…, { fixtures: [...BEHAVIOUR_FIXTURES, ext] }), replaces this empty part (mergeFixtures); K1 declares its canvas handle by augmenting LaneHandles there.',
    cases: [],
  },
  {
    name: 'checkMany',
    facets: ['canvas'],
    lanes: ['K1'],
    note: 'K1 task 8: checkMany over the 30 permissions equals 30 single checks for every (principal, resource) of the cases. K1 fills it: a FixtureExtension with the same id and part name, written in test/canvas-c6/ and passed through runBehaviour(…, { fixtures: [...BEHAVIOUR_FIXTURES, ext] }), replaces this empty part (mergeFixtures); K1 declares its canvas handle by augmenting LaneHandles there.',
    cases: [],
  },
  {
    name: 'list',
    facets: ['canvas', 'list', 'sql'],
    lanes: ['K1', 'L4b'],
    note: "K1 task 9: for every principal of the cases, filter over the state's projects and files returns exactly the resources whose check allows (with B44). K1 fills it: a FixtureExtension with the same id and part name, written in test/canvas-c6/ and passed through runBehaviour(…, { fixtures: [...BEHAVIOUR_FIXTURES, ext] }), replaces this empty part (mergeFixtures); K1 declares its canvas handle by augmenting LaneHandles there.",
    cases: [],
  },
]);
