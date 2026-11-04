import { companionHeader, manifestHashCheck } from '../companion.js';
import type { ClientModel } from '../model.js';
import { withUseClient } from './directive.js';
import { hookRoutes, type HookRoute } from './shared.js';

export interface SwrOptions {
  keyPrefix?: string;
  /** File name of the client without extension, default `client`. */
  basename?: string;
}

const MUTATION_KEY = 'readonly unknown[]';

// Every hook in the file shares these, so each signature stays short.
const HELPERS = [
  `type MutationConfig<Data, Vars> = SWRMutationConfiguration<Data, AppClientError, ${MUTATION_KEY}, Vars> & {`,
  '  /** Key prefixes to revalidate once the mutation succeeded; replaces the default, the whole controller. `false` revalidates nothing. */',
  `  invalidate?: false | readonly (${MUTATION_KEY})[];`,
  '};',
  '',
  `type MutationResult<Data, Vars> = SWRMutationResponse<Data, AppClientError, ${MUTATION_KEY}, Vars>;`,
  '',
  '// An array key hashes to a string whose elements end in commas, so a prefix key hashes to a prefix of its longer keys.',
  `const under = (prefix: ${MUTATION_KEY}) => {`,
  '  const head = unstable_serialize(prefix);',
  '  return (key: unknown) => Array.isArray(key) && unstable_serialize(key).startsWith(head);',
  '};',
];

// `null` is SWR's conditional fetch, so it has to stay assignable next to the `{}` default of an optional variables object.
function varsParameter(hook: HookRoute): string {
  const type = `${hook.varsType} | null`;
  return hook.varsOptional ? `vars: ${type} = {}` : `vars: ${type}`;
}

function queryHook(hook: HookRoute): string[] {
  const { returns } = hook.route;
  return [
    `export function ${hook.hookName}(${varsParameter(hook)}, config?: SWRConfiguration<${returns}, AppClientError>): SWRResponse<${returns}, AppClientError> {`,
    '  const client = useAppClient();',
    `  return useSWR<${returns}, AppClientError>(vars && ${hook.keyExpression}, vars && (() => ${hook.callExpression}), config);`,
    '}',
  ];
}

function mutationHook(hook: HookRoute): string[] {
  const { returns } = hook.route;
  const generics = `${returns}, ${hook.varsType}`;
  return [
    `export function ${hook.hookName}(config?: MutationConfig<${generics}>): MutationResult<${generics}> {`,
    '  const client = useAppClient();',
    '  const { mutate } = useSWRConfig();',
    `  const { invalidate = [appKeys.${hook.route.controllerKey}.all], ...rest } = config ?? {};`,
    `  return useSWRMutation<${returns}, AppClientError, ${MUTATION_KEY}, ${hook.varsType}>(`,
    `    ${hook.keyExpression},`,
    '    async (_key, { arg: vars }) => {',
    `      const result = await ${hook.callExpression};`,
    // Awaiting keeps the mutation pending until the refetch settles, like the React Query hooks.
    '      if (invalidate) await Promise.all(invalidate.map((prefix) => mutate(under(prefix))));',
    '      return result;',
    '    },',
    '    rest,',
    '  );',
    '}',
  ];
}

function typeImports(hooks: HookRoute[]): string[] {
  const names = hooks.flatMap((h) => [...h.route.returnNames, ...h.route.args.flatMap((a) => a.typeNames)]);
  return [...new Set(names)].sort();
}

/** `client.swr.ts`: a `useSWR` hook per query route and a `useSWRMutation` hook per mutation route. */
export function emitSwr(model: ClientModel, options: SwrOptions = {}): string {
  const hooks = hookRoutes(model, options);
  const base = options.basename ?? 'client';
  const lines = [
    companionHeader('swr', model),
    "import useSWR, { unstable_serialize, useSWRConfig, type SWRConfiguration, type SWRResponse } from 'swr';",
    "import useSWRMutation, { type SWRMutationConfiguration, type SWRMutationResponse } from 'swr/mutation';",
    `import { appKeys, type AppClientError } from './${base}.keys.js';`,
    `import { useAppClient } from './${base}.react.js';`,
    `import type { ${[...typeImports(hooks), 'manifestHash'].join(', ')} } from './${base}.js';`,
    '',
    ...manifestHashCheck(model),
    '',
    ...HELPERS,
    ...hooks.flatMap((h) => ['', ...(h.route.kind === 'query' ? queryHook(h) : mutationHook(h))]),
  ];
  return withUseClient(`${lines.join('\n')}\n`);
}
