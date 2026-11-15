import { companionHeader, manifestHashCheck } from '../companion.js';
import type { ClientModel } from '../model.js';
import { withUseClient } from './directive.js';
import { typeNames, varsParameter, type HookRoute, type InfiniteHook } from './shared.js';

export interface ReactQueryOptions {
  /** File name of the client without extension, default `client`. */
  basename?: string;
}

const isQuery = (hook: HookRoute) => hook.route.kind === 'query';

const isInfinite = (hook: HookRoute): hook is HookRoute & { infinite: InfiniteHook } => hook.infinite !== undefined;

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
  const plain = [
    `    ${name}: (client: AppClient, ${varsParameter(hook)}) =>`,
    `      queryOptions<${queryData(hook)}, AppClientError>({ queryKey: appKeys.${controllerKey}.${name}(vars), queryFn: ${queryFn(hook)} }),`,
  ];
  return [...plain, ...(isInfinite(hook) ? infiniteEntry(hook) : [])].join('\n');
}

function infiniteEntry(hook: HookRoute & { infinite: InfiniteHook }): string[] {
  const { infinite } = hook;
  const key = `appKeys.${hook.route.controllerKey}.${infinite.keyName}(vars)`;
  const options =
    infinite.kind === 'offset' ? `offsetPages(${key}, ${infinite.firstPage}, (pageParam) => ${infinite.call('vars', 'pageParam')})` : `cursorPages(${key}, (cursor) => ${infinite.call('vars', 'cursor')})`;
  return [`    ${infinite.keyName}: (client: AppClient, ${varsParameter(infinite)}) =>`, `      ${options},`];
}

const PAGES = [
  '// The next offset page is counted from the items seen, not from the page size, so it also ends when the server clamps the size.',
  '// An empty reply (an optional page left out) is an empty page, which ends the data: React Query rejects undefined page data.',
  'const offsetPages = <T extends { items: readonly unknown[]; total: number }>(queryKey: QueryKey, initialPageParam: number, fetchPage: (page: number) => Promise<T | undefined>) =>',
  '  infiniteQueryOptions<T, AppClientError, InfiniteData<T, number>, QueryKey, number>({',
  '    queryKey,',
  '    queryFn: ({ pageParam }) => fetchPage(pageParam).then((page) => page ?? ({ items: [], total: 0 } as unknown as T)),',
  '    initialPageParam,',
  '    getNextPageParam: (last, all, lastParam) => (last.items.length > 0 && all.reduce((seen, p) => seen + p.items.length, 0) < last.total ? lastParam + 1 : undefined),',
  '  });',
  '',
  'const cursorPages = <T extends { next: string | null }>(queryKey: QueryKey, fetchPage: (cursor: string | null) => Promise<T | undefined>) =>',
  '  infiniteQueryOptions<T, AppClientError, InfiniteData<T, string | null>, QueryKey, string | null>({',
  '    queryKey,',
  '    queryFn: ({ pageParam }) => fetchPage(pageParam).then((page) => page ?? ({ items: [], next: null } as unknown as T)),',
  '    initialPageParam: null,',
  '    getNextPageParam: (last) => last.next ?? undefined,',
  '  });',
  '',
];

/** `client.queries.ts`: `appQueries`, the React Query options of every GET route. Server-safe, so loaders and Server Components can prefetch. */
export function emitQueries(model: ClientModel, hooks: HookRoute[], options: ReactQueryOptions = {}): string {
  const queries = hooks.filter(isQuery);
  const any = queries.length > 0;
  const infinite = queries.some(isInfinite);
  const controllers = groupByController(model, queries).map(([key, own]) => [`  ${key}: {`, ...own.map(queryEntry), '  },'].join('\n'));
  const lines = [
    companionHeader('react-query', model),
    ...importLine([infinite && 'infiniteQueryOptions', any && 'queryOptions', infinite && 'type InfiniteData', infinite && 'type QueryKey'], '@tanstack/react-query'),
    ...importLine([any && 'appKeys', any && 'type AppClientError'], `./${options.basename ?? 'client'}.keys.js`),
    ...importLine([...typeNames(queries, any ? ['AppClient'] : []), 'manifestHash'], `./${options.basename ?? 'client'}.js`, true),
    '',
    ...manifestHashCheck(model),
    '',
    ...(queries.some((h) => !isVoid(h)) ? NULL_IF_EMPTY : []),
    ...(infinite ? PAGES : []),
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

function infiniteHook(hook: HookRoute & { infinite: InfiniteHook }): string {
  const { infinite } = hook;
  const factory = `appQueries.${hook.route.controllerKey}.${infinite.keyName}`;
  const page = infinite.kind === 'offset' ? 'number' : 'string | null';
  return [
    `export function ${infinite.hookName}(${varsParameter(infinite)}, options?: InfiniteQueryOpts<ReturnType<typeof ${factory}>>): UseInfiniteQueryResult<InfiniteData<${hook.route.returns}, ${page}>, AppClientError> {`,
    `  return useInfiniteQuery({ ...${factory}(useAppClient(), vars), ...options });`,
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

const INFINITE_QUERY_OPTS = [
  '/** Options of an infinite query hook; the key, the query function and the page parameters come from `appQueries`. */',
  "export type InfiniteQueryOpts<O> = Partial<Omit<O, 'queryKey' | 'queryFn' | 'initialPageParam' | 'getNextPageParam'>>;",
];

const MUTATION_OPTS = [
  '/**',
  ' * Options of a mutation hook. `invalidate` lists the query keys to invalidate after a success, default the',
  " * controller's `appKeys.<controller>.all`; a query several keys match refetches once, and the mutation stays pending",
  ' * until the refetch settles. `false` invalidates nothing. `TContext` is what `onMutate` returns, for `onError` to read.',
  ' */',
  "export type MutationOpts<T, V, TContext = unknown> = Omit<UseMutationOptions<T, AppClientError, V, TContext>, 'mutationFn'> & { invalidate?: false | readonly QueryKey[] };",
];

type Uses = Record<'queries' | 'mutations' | 'any' | 'infinite', boolean>;

// Each library name with what the file must contain to use it, in import order.
const LIBRARY: [string, keyof Uses][] = [
  ['matchQuery', 'mutations'], ['useInfiniteQuery', 'infinite'], ['useMutation', 'mutations'], ['useQuery', 'queries'], ['useQueryClient', 'mutations'],
  ['type InfiniteData', 'infinite'], ['type QueryKey', 'any'], ['type UseInfiniteQueryResult', 'infinite'], ['type UseMutationOptions', 'mutations'],
  ['type UseMutationResult', 'mutations'], ['type UseQueryOptions', 'queries'], ['type UseQueryResult', 'queries'],
];

function reactQueryImports(hooks: HookRoute[], basename: string): string[] {
  const uses: Uses = { queries: hooks.some(isQuery), mutations: hooks.some((h) => !isQuery(h)), any: hooks.length > 0, infinite: hooks.some(isInfinite) };
  return [
    ...importLine(LIBRARY.map(([name, use]) => uses[use] && name), '@tanstack/react-query'),
    ...importLine([uses.mutations && 'appKeys', uses.any && 'type AppClientError'], `./${basename}.keys.js`),
    ...importLine([uses.queries && 'appQueries'], `./${basename}.queries.js`),
    ...importLine([uses.any && 'useAppClient'], `./${basename}.react.js`),
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
    ...(hooks.some(isInfinite) ? [...INFINITE_QUERY_OPTS, ''] : []),
    ...(hooks.some((h) => !isQuery(h)) ? [...MUTATION_OPTS, ''] : []),
    hooks.flatMap((h) => (isQuery(h) ? [queryHook(h), ...(isInfinite(h) ? [infiniteHook(h)] : [])] : [mutationHook(h)])).join('\n\n'),
  ];
  return withUseClient(`${lines.join('\n')}\n`);
}
