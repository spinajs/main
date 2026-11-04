import type { SocketControllerEntry, TypeRef } from '@spinajs/manifest';
import { companionHeader, manifestHashCheck } from '../companion.js';
import type { ClientModel } from '../model.js';
import { contractName } from '../socket.js';
import { literal, type TypeContext } from '../ts-type.js';
import { withUseClient } from './directive.js';
import { DEFAULT_KEY_PREFIX } from './shared.js';

export interface SocketHooksOptions {
  keyPrefix?: string;
  /** File name of the client without extension, default `client`. */
  basename?: string;
}

interface Printed {
  type: string;
  names: string[];
}

export interface SocketEventHook {
  event: string;
  /** `use<Contract><Event>Event`. */
  hookName: string;
  /** `use<Contract><Event>Latest`, the SWR flavour. */
  latestName: string;
  payload: Printed;
}

export interface SocketStreamHook {
  command: string;
  /** `use<Contract><Command>Stream`. */
  hookName: string;
  payload: Printed;
  item: Printed;
}

export interface SocketContractHooks {
  controller: SocketControllerEntry;
  /** The `defineContract` constant in `client.ts`. */
  contract: string;
  /** The contract name without `Contract`, a segment of the SWR subscription key. */
  key: string;
  /** `<Contract>Socket`, the contract's `TypedSocketClient`. */
  socketType: string;
  events: SocketEventHook[];
  streams: SocketStreamHook[];
}

// Names the socket files declare or import besides the hooks, so an imported type must not take them.
const SOCKET_FILE_NAMES = [
  ...['SocketStreamState', 'IDLE', 'OPENING', 'useLatest', 'useIsomorphicLayoutEffect', 'useSocketStream', 'ContractOf', 'TypedSocketClient', 'manifestHash'],
  ...['useSWRSubscription', 'SWRSubscriptionResponse', 'socketIds', 'lastSocketId', 'socketId', 'useEffect', 'useLayoutEffect', 'useRef', 'useState'],
];

/** `LIFECYCLE_EVENTS` of `@spinajs/http-socket-client`: `SocketClient.on()` routes these names to its own listeners. */
export const CLIENT_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(['state', 'auth_required', 'incompatible', 'refused', 'acked', 'failed', 'held']);

const REMEDY = 'to generate socket hooks, or generate without socketHooks';

const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

function contractHooks(controller: SocketControllerEntry, model: ClientModel): SocketContractHooks {
  const print = (ref: TypeRef): Printed => model.ctx.withNames(() => model.ctx.typeOf(ref));
  const contract = contractName(controller.prefix, controller.className);
  const key = contract.slice(0, -'Contract'.length);
  const base = pascal(key);
  return {
    controller,
    contract,
    key,
    socketType: `${/^[0-9]/.test(base) ? '_' : ''}${base}Socket`,
    events: controller.events.map((e) => ({ event: e.name, hookName: `use${base}${pascal(e.name)}Event`, latestName: `use${base}${pascal(e.name)}Latest`, payload: print(e.payload) })),
    streams: controller.commands.filter((c) => c.stream).map((c) => ({ command: c.name, hookName: `use${base}${pascal(c.name)}Stream`, payload: print(c.payload), item: print(c.result) })),
  };
}

type Schema = Record<string, unknown>;

const asSchema = (value: unknown): Schema | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Schema) : undefined);

const members = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

function allowsNull(value: unknown, ctx: TypeContext, seen: ReadonlySet<string> = new Set()): boolean {
  const schema = asSchema(value);
  if (!schema) return false;
  if (typeof schema.$ref === 'string') return !seen.has(schema.$ref) && allowsNull(ctx.schemaOf(schema.$ref), ctx, new Set([...seen, schema.$ref]));
  if (members(schema.type).includes('null') || schema.type === 'null' || schema.const === null || members(schema.enum).includes(null)) return true;
  const nullable = (m: unknown) => allowsNull(m, ctx, seen);
  const allOf = members(schema.allOf);
  return members(schema.anyOf).some(nullable) || members(schema.oneOf).some(nullable) || (allOf.length > 0 && allOf.every(nullable));
}

// A lifecycle name never reaches a server listener, and a nullable payload cannot be told apart from the null that turns a stream hook off.
function refuseUnreachable(c: SocketContractHooks, ctx: TypeContext): void {
  const lifecycle = c.events.find((e) => CLIENT_LIFECYCLE_EVENTS.has(e.event));
  if (lifecycle) throw new Error(`generateClientFiles: ${c.controller.className} event '${lifecycle.event}' shares its name with a socket client lifecycle event, so SocketClient.on() would never deliver it; rename the event ${REMEDY}`);
  for (const s of c.streams) {
    const command = c.controller.commands.find((cmd) => cmd.name === s.command);
    const schema = command?.payload.schema ? ctx.schemaOf(command.payload.schema) : undefined;
    if (s.payload.type === 'unknown' || allowsNull(schema, ctx)) {
      throw new Error(`generateClientFiles: ${c.controller.className} stream '${s.command}' takes a payload typed ${s.payload.type}, which allows null, but null turns a stream hook off; give the payload a type without null ${REMEDY}`);
    }
  }
}

function refuseSharedNames(contracts: SocketContractHooks[]): void {
  const seen = new Map<string, string>();
  const claim = (name: string, label: string) => {
    const first = seen.get(name);
    if (first !== undefined) throw new Error(`generateClientFiles: ${first} and ${label} would both be ${name}; rename one ${REMEDY}`);
    seen.set(name, label);
  };
  for (const name of SOCKET_FILE_NAMES) seen.set(name, `the socket hooks' own ${name}`);
  for (const c of contracts) {
    const of = (what: string) => `${c.controller.className} ${what}`;
    claim(c.socketType, of('socket type'));
    for (const e of c.events) {
      claim(e.hookName, of(`event '${e.event}'`));
      claim(e.latestName, of(`event '${e.event}'`));
    }
    for (const s of c.streams) claim(s.hookName, of(`stream '${s.command}'`));
  }
  for (const name of typeNames(contracts)) {
    const taken = seen.get(name);
    if (taken !== undefined) throw new Error(`generateClientFiles: the type ${name} and ${taken} would share a name in the socket hooks; rename one ${REMEDY}`);
  }
}

/** The event and stream hooks of every socket contract of the model, in client order. */
export function socketHooks(model: ClientModel): SocketContractHooks[] {
  const contracts = model.sockets.map((s) => contractHooks(s, model));
  for (const c of contracts) refuseUnreachable(c, model.ctx);
  refuseSharedNames(contracts);
  return contracts;
}

function typeNames(contracts: SocketContractHooks[], options: { latest?: boolean } = {}): string[] {
  const printed = contracts.flatMap((c) => (options.latest ? c.events.map((e) => e.payload) : [...c.events.map((e) => e.payload), ...c.streams.flatMap((s) => [s.payload, s.item])]));
  return [...new Set(printed.flatMap((p) => p.names))].sort();
}

const STREAM_HELPERS = [
  '/** What a stream hook has received so far; `error` is what ended the stream, a `SocketException` from the socket client. */',
  'export interface SocketStreamState<T> {',
  '  items: T[];',
  "  status: 'idle' | 'streaming' | 'done' | 'error';",
  '  error: unknown;',
  '}',
  '',
  "const IDLE: SocketStreamState<never> = { items: [], status: 'idle', error: undefined };",
  "const OPENING: SocketStreamState<never> = { items: [], status: 'streaming', error: undefined };",
  '',
  '// Reopens only when the socket or the JSON of the payload changes, so an inline payload object does not restart it on every render.',
  'function useSocketStream<S, P, T>(socket: S, payload: P | null, open: (socket: S, payload: P) => AsyncIterator<T>): SocketStreamState<T> {',
  '  const key = payload === null ? null : JSON.stringify(payload);',
  '  const [state, setState] = useState<{ socket: S; key: string | null; view: SocketStreamState<T> }>({ socket, key: null, view: IDLE });',
  '  const latest = useLatest({ payload, open });',
  '  useEffect(() => {',
  '    const { payload: current, open: start } = latest.current;',
  '    if (current === null) {',
  '      setState((s) => (s.socket === socket && s.key === key ? s : { socket, key, view: IDLE }));',
  '      return undefined;',
  '    }',
  '    let active = true;',
  '    let iterator: AsyncIterator<T> | undefined;',
  '    const update = (change: (view: SocketStreamState<T>) => SocketStreamState<T>) => {',
  '      if (active) setState((s) => ({ ...s, view: change(s.view) }));',
  '    };',
  '    setState({ socket, key, view: OPENING });',
  '    void (async () => {',
  '      try {',
  '        iterator = start(socket, current);',
  '        for (let next = await iterator.next(); active && !next.done; next = await iterator.next()) {',
  '          const item = next.value;',
  '          update((view) => ({ ...view, items: [...view.items, item] }));',
  '        }',
  "        update((view) => ({ ...view, status: 'done' }));",
  '      } catch (error: unknown) {',
  "        update((view) => ({ ...view, status: 'error', error }));",
  '      }',
  '    })();',
  '    return () => {',
  '      active = false;',
  '      void iterator?.return?.();',
  '    };',
  '  }, [socket, key, latest]);',
  '  // Until the effect has run for this socket and payload, the state still holds the previous stream.',
  '  if (state.socket === socket && state.key === key) return state.view;',
  '  return key === null ? IDLE : OPENING;',
  '}',
];

// Updated in the commit rather than during render, so a render React throws away never reaches a subscription.
const LATEST_HELPER = [
  "// A layout effect updates the ref before any event can arrive; on the server, where it would warn in React 18, useEffect.",
  "const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;",
  '',
  'function useLatest<T>(value: T): { readonly current: T } {',
  '  const ref = useRef(value);',
  '  useIsomorphicLayoutEffect(() => {',
  '    ref.current = value;',
  '  });',
  '  return ref;',
  '}',
];

function eventHook(c: SocketContractHooks, e: SocketEventHook): string[] {
  return [
    `export function ${e.hookName}(socket: ${c.socketType}, listener: (payload: ${e.payload.type}) => void): void {`,
    '  const latest = useLatest(listener);',
    `  useEffect(() => socket.on(${literal(e.event)}, (payload) => {`,
    '    latest.current(payload);',
    '  }), [socket, latest]);',
    '}',
  ];
}

function streamHook(c: SocketContractHooks, s: SocketStreamHook): string[] {
  return [
    `export function ${s.hookName}(socket: ${c.socketType}, payload: ${s.payload.type} | null): SocketStreamState<${s.item.type}> {`,
    `  return useSocketStream(socket, payload, (client, p) => client.stream(${literal(s.command)}, p));`,
    '}',
  ];
}

function reactImport(contracts: SocketContractHooks[]): string[] {
  const events = contracts.some((c) => c.events.length > 0);
  const streams = contracts.some((c) => c.streams.length > 0);
  const names = [...(events || streams ? ['useEffect', 'useLayoutEffect', 'useRef'] : []), ...(streams ? ['useState'] : [])];
  return names.length > 0 ? [`import { ${names.join(', ')} } from 'react';`] : [];
}

/** `client.socket.ts`: an event hook per socket event and a stream hook per stream command, over `TypedSocketClient`. */
export function emitSocketHooks(model: ClientModel, options: SocketHooksOptions = {}): string {
  const contracts = socketHooks(model);
  const anyHooks = contracts.some((c) => c.events.length > 0 || c.streams.length > 0);
  const anyStreams = contracts.some((c) => c.streams.length > 0);
  const clientImports = [...typeNames(contracts), ...contracts.map((c) => c.contract), 'manifestHash'];
  const lines = [
    companionHeader('socket', model),
    ...reactImport(contracts),
    ...(contracts.length > 0 ? ["import type { ContractOf, TypedSocketClient } from '@spinajs/http-socket-client';"] : []),
    `import type { ${clientImports.join(', ')} } from './${options.basename ?? 'client'}.js';`,
    '',
    ...manifestHashCheck(model),
    ...contracts.flatMap((c) => ['', `export type ${c.socketType} = TypedSocketClient<ContractOf<typeof ${c.contract}>>;`]),
    ...(anyHooks ? ['', ...LATEST_HELPER] : []),
    ...(anyStreams ? ['', ...STREAM_HELPERS] : []),
    ...contracts.flatMap((c) => [...c.events.flatMap((e) => ['', ...eventHook(c, e)]), ...c.streams.flatMap((s) => ['', ...streamHook(c, s)])]),
  ];
  return withUseClient(`${lines.join('\n')}\n`);
}

const SOCKET_ID_HELPER = [
  '// SWR hashes an object in a key by its content, which for a socket client includes its URL and auth headers.',
  'const socketIds = new WeakMap<object, number>();',
  'let lastSocketId = 0;',
  '',
  'function socketId(socket: object): number {',
  '  let id = socketIds.get(socket);',
  '  if (id === undefined) {',
  '    id = ++lastSocketId;',
  '    socketIds.set(socket, id);',
  '  }',
  '  return id;',
  '}',
];

/** `client.socket-swr.ts`: the latest payload of each socket event, on `swr/subscription`. */
export function emitSwrSocketHooks(model: ClientModel, options: SocketHooksOptions = {}): string {
  const contracts = socketHooks(model);
  const withEvents = contracts.filter((c) => c.events.length > 0);
  const basename = options.basename ?? 'client';
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const hooks = withEvents.flatMap((c) =>
    c.events.flatMap((e) => [
      '',
      `export function ${e.latestName}(socket: ${c.socketType}): SWRSubscriptionResponse<${e.payload.type}, never> {`,
      `  const key = [${[prefix, '#socket', c.key, e.event].map(literal).join(', ')}, socketId(socket)] as const;`,
      `  return useSWRSubscription<${e.payload.type}, never, typeof key>(key, (_key, { next }) =>`,
      `    socket.on(${literal(e.event)}, (payload) => {`,
      '      next(null, payload);',
      '    }),',
      '  );',
      '}',
    ]),
  );
  const lines = [
    companionHeader('socket-swr', model),
    ...(withEvents.length > 0 ? ["import useSWRSubscription, { type SWRSubscriptionResponse } from 'swr/subscription';"] : []),
    `import type { ${[...typeNames(withEvents, { latest: true }), 'manifestHash'].join(', ')} } from './${basename}.js';`,
    ...(withEvents.length > 0 ? [`import type { ${withEvents.map((c) => c.socketType).join(', ')} } from './${basename}.socket.js';`] : []),
    '',
    ...manifestHashCheck(model),
    ...(withEvents.length > 0 ? ['', ...SOCKET_ID_HELPER] : []),
    ...hooks,
  ];
  return withUseClient(`${lines.join('\n')}\n`);
}
