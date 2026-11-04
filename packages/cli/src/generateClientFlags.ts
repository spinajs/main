import type { GenerateClientFilesOptions, GeneratorTarget } from '@spinajs/client';

export interface GenerateClientFlags {
  manifest: string;
  out: string;
  module?: string;
  socket: boolean;
  hooks?: string[];
  zod?: boolean;
  zodMini?: boolean;
  zodReplies?: boolean;
  zodUnsupported?: 'warn' | 'error';
  models?: boolean;
  socketHooks?: boolean;
  keyPrefix?: string;
  server?: boolean;
  next?: boolean;
  mocks?: boolean;
  msw?: boolean;
  check?: boolean;
}

type TargetTable = Readonly<Record<GeneratorTarget, { readonly available: boolean }>>;

export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Flags that only qualify another flag, paired with the flag they need. */
function missingParent(flags: GenerateClientFlags): string | undefined {
  const needs: [boolean | string | undefined, string, boolean | undefined, string][] = [
    [flags.zodMini, '--zod-mini', flags.zod, '--zod'],
    [flags.zodReplies, '--zod-replies', flags.zod, '--zod'],
    [flags.zodUnsupported, '--zod-unsupported', flags.zod, '--zod'],
    [flags.msw, '--msw', flags.mocks, '--mocks'],
    [flags.socketHooks, '--socket-hooks', flags.hooks !== undefined && flags.hooks.length > 0, '--hooks'],
  ];
  const bad = needs.find(([given, , parent]) => given && !parent);
  return bad && `${bad[1]} needs ${bad[3]}`;
}

export function toFilesOptions(flags: GenerateClientFlags): Omit<GenerateClientFilesOptions, 'manifest' | 'basename'> {
  const problem = missingParent(flags);
  if (problem) throw new Error(problem);

  const zod = flags.zod ? { ...(flags.zodMini && { mini: true }), ...(flags.zodReplies && { replies: true }), ...(flags.zodUnsupported && { unsupported: flags.zodUnsupported }) } : undefined;
  return {
    moduleName: flags.module,
    includeSocket: flags.socket ? undefined : false,
    hooks: flags.hooks as GenerateClientFilesOptions['hooks'],
    zod,
    models: flags.models,
    socketHooks: flags.socketHooks,
    keyPrefix: flags.keyPrefix,
    server: flags.server,
    next: flags.next,
    mocks: flags.mocks,
    msw: flags.msw,
  };
}

/** The first requested flag whose emitter has not landed, as the user typed it. */
export function unavailableFlag(flags: GenerateClientFlags, targets: TargetTable): string | undefined {
  const requested: [string, GeneratorTarget[]][] = [
    ...(flags.hooks ?? []).map((h): [string, GeneratorTarget[]] => [`--hooks ${h}`, [h as GeneratorTarget]]),
    ...([
      [flags.zod, '--zod', ['zod']],
      [flags.models, '--models', ['models']],
      [flags.socketHooks, '--socket-hooks', ['socket-hooks']],
      [flags.server, '--server', ['server']],
      [flags.next, '--next', ['server', 'next']],
      [flags.mocks, '--mocks', ['mocks']],
      [flags.msw, '--msw', ['msw']],
    ] as [boolean | undefined, string, GeneratorTarget[]][]).flatMap(([on, flag, t]): [string, GeneratorTarget[]][] => (on ? [[flag, t]] : [])),
  ];
  // An unknown hooks value has no table entry; generateClientFiles rejects it with the allowed list.
  return requested.find(([, ts]) => ts.some((t) => targets[t] !== undefined && !targets[t].available))?.[0];
}
