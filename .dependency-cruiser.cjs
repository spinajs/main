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
      // Imports by package name resolve into the target's lib/, which this rule leaves alone.
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
      comment: 'Published code imports a devDependency: it is missing for consumers at runtime. A dependency also declared as a peer comes from the consumer.',
      from: { path: '^packages/[^/]+/src/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only', 'npm-peer'], pathNot: ['node_modules/@types/'] },
    },
    {
      name: 'authz-not-to-authn',
      severity: 'error',
      comment: 'authz installs without authn (D11): principal contracts come from @spinajs/principal. Only the optional @spinajs/authz-http/authn subpath may import authn.',
      from: { path: '^packages/authz[^/]*/src/', pathNot: '^packages/authz-http/src/authn/' },
      to: { path: ['^packages/authn[^/]*/', 'node_modules/@spinajs/authn[^/]*/'] },
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
      name: 'client-runtime-self-contained',
      severity: 'error',
      comment: '@spinajs/client/runtime runs in browser bundles: no npm packages, no Node built-ins; only @spinajs/client/formats from the rest of the package.',
      from: { path: '^packages/client/src/runtime/' },
      to: { pathNot: ['^packages/client/src/runtime/', '^packages/client/src/formats/'] },
    },
    {
      name: 'client-mocks-self-contained',
      severity: 'error',
      comment: '@spinajs/client/mocks runs in browser bundles and test runners: no npm packages, no Node built-ins; only @spinajs/client/formats from the rest of the package.',
      from: { path: '^packages/client/src/mocks/' },
      to: { pathNot: ['^packages/client/src/mocks/', '^packages/client/src/formats/'] },
    },
    {
      name: 'client-formats-leaf',
      severity: 'error',
      comment: '@spinajs/client/formats runs in browser bundles and imports nothing outside its own folder.',
      from: { path: '^packages/client/src/formats/' },
      to: { pathNot: '^packages/client/src/formats/' },
    },
    {
      name: 'no-deprecated-core',
      severity: 'warn',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|constants|sys|_linklist|_stream_wrap)$' },
    },
  ],
  options: {
    // lib/ is not followed rather than excluded: an import by package name resolves there, and authz-not-to-authn needs the target.
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
