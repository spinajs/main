// Existing violations live in .dependency-cruiser-known-violations.json (`npm run deps:baseline`
// rewrites it); `npm run deps` fails only on new ones.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Runtime import cycle: module init order decides which side sees undefined.',
      from: { path: '^packages/[^/]+/src/' },
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-cross-package-relative',
      severity: 'error',
      comment: "Reach another package through its name and exports, not a relative path into its files.",
      // Tests may share another package's test suites (e.g. session-provider conformance).
      from: { path: '^packages/([^/]+)/src/' },
      to: { path: '^packages/', pathNot: ['^packages/$1/', '^packages/[^/]+/lib/'] },
    },
    {
      name: 'src-not-to-test',
      severity: 'error',
      from: { path: '^packages/[^/]+/src/' },
      to: { path: '^packages/[^/]+/test/' },
    },
    {
      name: 'src-not-to-dev-dep',
      severity: 'error',
      comment: 'Published code imports a devDependency: it is missing for consumers at runtime.',
      from: { path: '^packages/[^/]+/src/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'], pathNot: ['node_modules/@types/'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      // Platform-specific optional packages: only one of them is installed on a given OS.
      to: { couldNotResolve: true, pathNot: '^exiftool-vendored[.](exe|pl)$' },
    },
    {
      name: 'hooks-not-to-auth',
      severity: 'error',
      comment: 'The hooks core stays usable by orm, queue or http: authn, authz and users depend on it, never the reverse.',
      from: { path: '^packages/hooks/' },
      to: { path: ['^packages/(authn|authz|users)[^/]*/', '(^|/)node_modules/@spinajs/(authn|authz|users)[^/]*/'] },
    },
    {
      name: 'no-deprecated-core',
      severity: 'warn',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|constants|sys|_linklist|_stream_wrap)$' },
    },
  ],
  options: {
    // Built lib/ is a leaf, not excluded: a package import resolves into the other package's lib/, and a rule on
    // which packages a package imports (hooks-not-to-auth) needs that module in the graph.
    doNotFollow: { path: ['node_modules', '(^|/)lib/'] },
    exclude: { path: ['/test/fixtures/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.d.ts', '.cjs', '.mjs'],
      mainFields: ['main', 'types', 'typings'],
    },
    skipAnalysisNotInRules: true,
  },
};
