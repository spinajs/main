import { companionHeader, manifestHashCheck } from '../companion.js';
import type { ClientModel } from '../model.js';
import { withUseClient } from './directive.js';
import { typeNames, varsParameter, type HookRoute } from './shared.js';

export interface ReactQueryOptions {
  /** File name of the client without extension, default `client`. */
  basename?: string;
}

const isQuery = (hook: HookRoute) => hook.route.kind === 'query';

const isVoid = (hook: HookRoute) => hook.route.returns === 'void';

// React Query rejects `undefined` as query data, so a query whose reply is empty resolves to `null`.
const queryData = (hook: HookRoute) => (isVoid(hook) ? 'null' : hook.route.returns);

const queryFn = (hook: HookRoute) => `() => ${hook.callExpression}.then(${isVoid(hook) ? '() => null' : 'nullIfEmpty'})`;

const NULL_IF_EMPTY = [
  '// The client resolves a 204 reply to undefined, which React Query rejects as query data.',
  'const nullIfEmpty = <T>(data: T): T => data ?? (null as T);',
  '',
];

const mutationFn = (hook: HookRoute) => `(${hook.route.args.length > 0 ? 'vars' : ''}) => ${hook.callExpression}`;

// Every import is a named list filtered to what the file uses: an unused one would fail noUnusedLocals.
function importLine(names: (string | false)[], from: string, typeOnly = false): string[] {
  const used = names.filter((n): n is string => n !== false);
  return used.length > 0 ? [`import ${typeOnly ? 'type ' : ''}{ ${used.join(', ')} } from '${from}';`] : [];
}

function groupByController(model: ClientModel, hooks: HookRoute[]): [string, HookRoute[]][] {
  return model.controllers.map((c): [string, HookRoute[]] => [c.key, hooks.filter((h) => h.route.controllerKey === c.key)]).filter(([, own]) => own.length > 0);
}

function queryEntry(hook: HookRoute): string {
  const { controllerKey, name } = hook.route;
  return [
    `    ${name}: (client: AppClient, ${varsParameter(hook)}) =>`,
    `      queryOptions<${queryData(hook)}, AppClientError>({ queryKey: appKeys.${controllerKey}.${name}(vars), queryFn: ${queryFn(hook)} }),`,
  ].join('\n');
}

/** `client.queries.ts`: `appQueries`, the React Query options of every GET route. Server-safe, so loaders and Server Components can prefetch. */
export function emitQueries(model: ClientModel, hooks: HookRoute[], options: ReactQueryOptions = {}): string {
  const queries = hooks.filter(isQuery);
  const any = queries.length > 0;
  const controllers = groupByController(model, queries).map(([key, own]) => [`  ${key}: {`, ...own.map(queryEntry), '  },'].join('\n'));
  const lines = [
    companionHeader('react-query', model),
    ...importLine([any && 'queryOptions'], '@tanstack/react-query'),
    ...importLine([any && 'appKeys', any && 'type AppClientError'], `./${options.basename ?? 'client'}.keys.js`),
    ...importLine([...typeNames(queries, any ? ['AppClient'] : []), 'manifestHash'], `./${options.basename ?? 'client'}.js`, true),
    '',
    ...manifestHashCheck(model),
    '',
    ...(queries.some((h) => !isVoid(h)) ? NULL_IF_EMPTY : []),
    '/** Each factory takes the client, so a server can prefetch with a per-request one: `queryClient.prefetchQuery(appQueries.<controller>.<handler>(client, vars))`. */',
    `export const appQueries = {${controllers.length > 0 ? `\n${controllers.join('\n')}\n` : ''}};`,
  ];
  return `${lines.join('\n')}\n`;
}

function queryHook(hook: HookRoute): string {
  const { controllerKey, name } = hook.route;
  const data = queryData(hook);
  return [
    `export function ${hook.hookName}(${varsParameter(hook)}, options?: QueryOpts<${data}>): UseQueryResult<${data}, AppClientError> {`,
    `  return useQuery({ ...appQueries.${controllerKey}.${name}(useAppClient(), vars), ...options });`,
    '}',
  ].join('\n');
}

function mutationHook(hook: HookRoute): string {
  const { controllerKey, returns } = hook.route;
  const types = `${returns}, AppClientError, ${hook.varsType}`;
  return [
    `export function ${hook.hookName}<TContext = unknown>(options?: MutationOpts<${returns}, ${hook.varsType}, TContext>): UseMutationResult<${types}, TContext> {`,
    '  const client = useAppClient();',
    '  const queryClient = useQueryClient();',
    `  const { invalidate = [appKeys.${controllerKey}.all], onSuccess, ...rest } = options ?? {};`,
    `  return useMutation<${types}, TContext>({`,
    `    mutationKey: ${hook.keyExpression},`,
    '    ...rest,',
    `    mutationFn: ${mutationFn(hook)},`,
    '    onSuccess: async (...args) => {',
    '      if (invalidate) await queryClient.invalidateQueries({ predicate: (query) => invalidate.some((queryKey) => matchQuery({ queryKey }, query)) });',
    '      return onSuccess?.(...args);',
    '    },',
    '  });',
    '}',
  ].join('\n');
}

const QUERY_OPTS = [
  '/** Options of a query hook; the key and the query function come from `appQueries`. */',
  "export type QueryOpts<T> = Omit<UseQueryOptions<T, AppClientError, T, QueryKey>, 'queryKey' | 'queryFn'>;",
];

const MUTATION_OPTS = [
  '/**',
  ' * Options of a mutation hook. `invalidate` lists the query keys to invalidate after a success, default the',
  " * controller's `appKeys.<controller>.all`; a query several keys match refetches once, and the mutation stays pending",
  ' * until the refetch settles. `false` invalidates nothing. `TContext` is what `onMutate` returns, for `onError` to read.',
  ' */',
  "export type MutationOpts<T, V, TContext = unknown> = Omit<UseMutationOptions<T, AppClientError, V, TContext>, 'mutationFn'> & { invalidate?: false | readonly QueryKey[] };",
];

function reactQueryImports(hooks: HookRoute[], basename: string): string[] {
  const [queries, mutations, any] = [hooks.some(isQuery), hooks.some((h) => !isQuery(h)), hooks.length > 0];
  const library = [mutations && 'matchQuery', mutations && 'useMutation', queries && 'useQuery', mutations && 'useQueryClient', any && 'type QueryKey', mutations && 'type UseMutationOptions', mutations && 'type UseMutationResult', queries && 'type UseQueryOptions', queries && 'type UseQueryResult'];
  return [
    ...importLine(library, '@tanstack/react-query'),
    ...importLine([mutations && 'appKeys', any && 'type AppClientError'], `./${basename}.keys.js`),
    ...importLine([queries && 'appQueries'], `./${basename}.queries.js`),
    ...importLine([any && 'useAppClient'], `./${basename}.react.js`),
    ...importLine([...typeNames(hooks, []), 'manifestHash'], `./${basename}.js`, true),
  ];
}

/** `client.react-query.ts`: a `use<Controller><Handler>` hook per query and mutation route. Client-only. */
export function emitReactQuery(model: ClientModel, hooks: HookRoute[], options: ReactQueryOptions = {}): string {
  const lines = [
    companionHeader('react-query', model),
    ...reactQueryImports(hooks, options.basename ?? 'client'),
    '',
    ...manifestHashCheck(model),
    '',
    ...(hooks.some(isQuery) ? [...QUERY_OPTS, ''] : []),
    ...(hooks.some((h) => !isQuery(h)) ? [...MUTATION_OPTS, ''] : []),
    hooks.map((h) => (isQuery(h) ? queryHook(h) : mutationHook(h))).join('\n\n'),
  ];
  return withUseClient(`${lines.join('\n')}\n`);
}
