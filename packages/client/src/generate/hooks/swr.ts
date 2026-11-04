import { companionHeader, manifestHashCheck } from '../companion.js';
import type { ClientModel } from '../model.js';
import { withUseClient } from './directive.js';
import { typeNames, type HookRoute, type InfiniteHook } from './shared.js';

export interface SwrOptions {
  /** File name of the client without extension, default `client`. */
  basename?: string;
}

const MUTATION_KEY = 'readonly unknown[]';

// Every hook in the file shares these, so each signature stays short.
const HELPERS = [
  `export type MutationConfig<Data, Vars> = SWRMutationConfiguration<Data, AppClientError, ${MUTATION_KEY}, Vars> & {`,
  '  /** Key prefixes to revalidate once the mutation succeeded; replaces the default, the whole controller. `false` revalidates nothing. */',
  `  invalidate?: false | readonly (${MUTATION_KEY})[];`,
  '};',
  '',
  `export type MutationResult<Data, Vars> = SWRMutationResponse<Data, AppClientError, ${MUTATION_KEY}, Vars>;`,
  '',
  '// An array key hashes to a string whose elements end in commas, so a prefix key hashes to a prefix of its longer keys.',
  `const under = (prefix: ${MUTATION_KEY}) => {`,
  '  const head = unstable_serialize(prefix);',
  '  return (key: unknown) => Array.isArray(key) && unstable_serialize(key).startsWith(head);',
  '};',
  '',
  // One filter for all prefixes, so a key under several of them is revalidated once.
  `const underAny = (prefixes: readonly (${MUTATION_KEY})[]) => {`,
  '  const matchers = prefixes.map(under);',
  '  return (key: unknown) => matchers.some((matches) => matches(key));',
  '};',
];

// Every import is filtered to what the file uses: an unused one would fail noUnusedLocals.
function importLine(defaultName: string | false, names: (string | false)[], from: string): string[] {
  const used = names.filter((n): n is string => n !== false);
  const parts = [...(defaultName ? [defaultName] : []), ...(used.length > 0 ? [`{ ${used.join(', ')} }`] : [])];
  return parts.length > 0 ? [`import ${parts.join(', ')} from '${from}';`] : [];
}

const INFINITE_CONFIG = [
  '',
  '/** SWR infinite options of an infinite hook. Without `parallel`: each page key is computed from the page before it. */',
  "export type InfiniteConfig<Data> = Omit<SWRInfiniteConfiguration<Data, AppClientError>, 'parallel'>;",
];

const PAGES: Record<InfiniteHook['kind'], string[]> = {
  offset: [
    '',
    '/** Page keys of an offset route: page `first + index`, until a page comes back empty or the items seen reach `total`. */',
    'const offsetPages = <K extends readonly unknown[]>(key: K | null, first: number) => {',
    '  // SWR asks for the page keys in order from page 0 in each pass, so the items before page i are counted when it asks for page i.',
    '  const seen: number[] = [];',
    '  return (index: number, previous: { items: readonly unknown[]; total: number } | null): readonly [...K, number] | null => {',
    '    if (!key) return null;',
    '    if (index > 0 && previous) {',
    '      seen[index] = (seen[index - 1] ?? 0) + previous.items.length;',
    '      if (previous.items.length === 0 || seen[index] >= previous.total) return null;',
    '    }',
    '    return [...key, first + index];',
    '  };',
    '};',
    '',
    '// An empty reply (an optional page left out) is an empty page, which ends the page keys.',
    'const emptyOffset = <T>(page: T): T => page ?? ({ items: [], total: 0 } as unknown as T);',
  ],
  cursor: [
    '',
    '/** Page keys of a cursor route: the first page under `null`, each next one under the cursor the page before returned. */',
    'const cursorPages =',
    '  <K extends readonly unknown[]>(key: K | null) =>',
    '  (index: number, previous: { next: string | null } | null): readonly [...K, string | null] | null => {',
    '    if (!key) return null;',
    '    if (index === 0) return [...key, null];',
    '    return previous && previous.next !== null ? [...key, previous.next] : null;',
    '  };',
    '',
    '// An empty reply (an optional page left out) is an empty page, which ends the page keys.',
    'const emptyCursor = <T>(page: T): T => page ?? ({ items: [], next: null } as unknown as T);',
  ],
};

const REVALIDATE = [
  '',
  '// `mutate(filter)` skips the entries of `useSWRInfinite`, and revalidating one refetches only the pages missing from the',
  '// cache besides its first. So the pages under the prefixes are dropped first, then each infinite entry is revalidated.',
  'async function revalidate(swr: ReturnType<typeof useSWRConfig>, prefixes: readonly (readonly unknown[])[]): Promise<void> {',
  '  const matches = underAny(prefixes);',
  "  await swr.mutate((key) => Array.isArray(key) && key[3] === 'infinite' && matches(key), undefined, { revalidate: false });",
  '  const heads = prefixes.map((prefix) => infiniteKey(() => prefix));',
  '  const infinite = [...swr.cache.keys()].filter((key) => heads.some((head) => key.startsWith(head)));',
  '  await Promise.all([swr.mutate(matches), ...infinite.map((key) => swr.mutate(key))]);',
  '}',
];

// `null` is SWR's conditional fetch, so it has to stay assignable next to the `{}` default of an optional variables object.
function varsParameter(hook: Pick<HookRoute, 'varsType' | 'varsOptional'>): string {
  const type = `${hook.varsType} | null`;
  return hook.varsOptional ? `vars: ${type} = {}` : `vars: ${type}`;
}

const isVoid = (hook: HookRoute) => hook.route.returns === 'void';

// As in the React Query hooks, an empty reply resolves to `null`, so it is told apart from data not loaded yet.
const queryData = (hook: HookRoute) => (isVoid(hook) ? 'null' : hook.route.returns);

const NULL_IF_EMPTY = ['', '// The client resolves a 204 reply to undefined, which SWR would show as data not loaded yet.', 'const nullIfEmpty = <T>(data: T): T => data ?? (null as T);'];

function queryHook(hook: HookRoute): string[] {
  const data = queryData(hook);
  const fetcher = `${hook.callExpression}.then(${isVoid(hook) ? '() => null' : 'nullIfEmpty'})`;
  return [
    `export function ${hook.hookName}(${varsParameter(hook)}, config?: SWRConfiguration<${data}, AppClientError>): SWRResponse<${data}, AppClientError> {`,
    '  const client = useAppClient();',
    `  return useSWR<${data}, AppClientError>(vars && ${hook.keyExpression}, vars && (() => ${fetcher}), config);`,
    '}',
  ];
}

function infiniteHook(hook: HookRoute, infinite: InfiniteHook): string[] {
  const { returns, controllerKey } = hook.route;
  const key = `vars && appKeys.${controllerKey}.${infinite.keyName}(vars)`;
  const [pages, empty] = infinite.kind === 'offset' ? [`offsetPages(${key}, ${infinite.firstPage})`, 'emptyOffset'] : [`cursorPages(${key})`, 'emptyCursor'];
  return [
    `export function ${infinite.hookName}(${varsParameter(infinite)}, config?: InfiniteConfig<${returns}>): SWRInfiniteResponse<${returns}, AppClientError> {`,
    '  const client = useAppClient();',
    `  const getKey = ${pages};`,
    // The key holds the variables (index 4) and the page parameter (index 5), so the fetcher reads both from it.
    `  return useSWRInfinite<${returns}, AppClientError, typeof getKey>(getKey, (key) => ${infinite.call('key[4]', 'key[5]')}.then(${empty}), { ...config, parallel: false });`,
    '}',
  ];
}

function mutationHook(hook: HookRoute, withInfinite: boolean): string[] {
  const { returns } = hook.route;
  const generics = `${returns}, ${hook.varsType}`;
  return [
    `export function ${hook.hookName}(config?: MutationConfig<${generics}>): MutationResult<${generics}> {`,
    '  const client = useAppClient();',
    withInfinite ? '  const swr = useSWRConfig();' : '  const { mutate } = useSWRConfig();',
    `  const { invalidate = [appKeys.${hook.route.controllerKey}.all], ...rest } = config ?? {};`,
    `  return useSWRMutation<${returns}, AppClientError, ${MUTATION_KEY}, ${hook.varsType}>(`,
    `    ${hook.keyExpression},`,
    '    async (_key, { arg: vars }) => {',
    `      const result = await ${hook.callExpression};`,
    // Awaiting keeps the mutation pending until the refetch settles, like the React Query hooks.
    withInfinite ? '      if (invalidate) await revalidate(swr, invalidate);' : '      if (invalidate) await mutate(underAny(invalidate));',
    '      return result;',
    '    },',
    '    rest,',
    '  );',
    '}',
  ];
}

// Nothing from `swr/infinite` without an infinite route; `infiniteKey` only for the mutations that revalidate them.
function infiniteImports(hooks: HookRoute[], mutations: boolean): string[] {
  if (!hooks.some((h) => h.infinite)) return [];
  return importLine('useSWRInfinite', [mutations && 'unstable_serialize as infiniteKey', 'type SWRInfiniteConfiguration', 'type SWRInfiniteResponse'], 'swr/infinite');
}

function imports(hooks: HookRoute[], base: string): string[] {
  const queries = hooks.some((h) => h.route.kind === 'query');
  const mutations = hooks.some((h) => h.route.kind !== 'query');
  const any = queries || mutations;
  return [
    ...importLine(queries && 'useSWR', [mutations && 'unstable_serialize', mutations && 'useSWRConfig', queries && 'type SWRConfiguration', queries && 'type SWRResponse'], 'swr'),
    ...infiniteImports(hooks, mutations),
    ...importLine(mutations && 'useSWRMutation', [mutations && 'type SWRMutationConfiguration', mutations && 'type SWRMutationResponse'], 'swr/mutation'),
    ...importLine(false, [any && 'appKeys', any && 'type AppClientError'], `./${base}.keys.js`),
    ...importLine(false, [any && 'useAppClient'], `./${base}.react.js`),
    `import type { ${[...typeNames(hooks), 'manifestHash'].join(', ')} } from './${base}.js';`,
  ];
}

/** `client.swr.ts`: a `useSWR` hook per query route and a `useSWRMutation` hook per mutation route. */
export function emitSwr(model: ClientModel, hooks: HookRoute[], options: SwrOptions = {}): string {
  const base = options.basename ?? 'client';
  const mutations = hooks.some((h) => h.route.kind !== 'query');
  const infinite = hooks.flatMap((h) => (h.infinite ? [h.infinite] : []));
  const kinds = (['offset', 'cursor'] as const).filter((kind) => infinite.some((i) => i.kind === kind));
  const lines = [
    companionHeader('swr', model),
    ...imports(hooks, base),
    '',
    ...manifestHashCheck(model),
    '',
    ...(mutations ? HELPERS : []),
    ...(hooks.some((h) => h.route.kind === 'query' && !isVoid(h)) ? NULL_IF_EMPTY : []),
    ...(kinds.length > 0 ? INFINITE_CONFIG : []),
    ...kinds.flatMap((kind) => PAGES[kind]),
    ...(infinite.length > 0 && mutations ? REVALIDATE : []),
    ...hooks.flatMap((h) => {
      if (h.route.kind !== 'query') return ['', ...mutationHook(h, infinite.length > 0)];
      return ['', ...queryHook(h), ...(h.infinite ? ['', ...infiniteHook(h, h.infinite)] : [])];
    }),
  ];
  return withUseClient(`${lines.join('\n')}\n`);
}
