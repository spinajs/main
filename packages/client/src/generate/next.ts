import { companionHeader, manifestHashCheck } from './companion.js';
import type { ClientModel } from './model.js';

export interface NextOptions {
  /** Import path of the runtime, default `@spinajs/client/runtime`. */
  moduleName?: string;
  /** File name of the client without extension, default `client`. */
  basename?: string;
}

const BODY = `type ControllerName = keyof typeof appTags;
type TaggedRoute<C extends ControllerName> = Exclude<keyof (typeof appTags)[C], 'all'>;

/** \`revalidate\` of a cached GET, in seconds; \`false\` keeps it until one of its tags is revalidated. */
export interface NextCacheOptions {
  revalidate?: number | false;
}

/** The second argument of Next 16's \`revalidateTag\`: a cache-life profile name such as \`'max'\`, or \`{ expire }\` in seconds. */
export type RevalidateProfile = string | { expire?: number };

/** The fetch options Next.js reads, typed here so that this file needs no Next type. */
export type NextFetchInit = RequestInit & { next?: { tags?: string[]; revalidate?: number | false } };

const tagsByController: Readonly<Record<string, Readonly<Record<string, string>>>> = appTags;

/**
 * An \`init\` that tags every GET with its controller and route tag. Tags and \`revalidate\` put the reply in Next's
 * cache, shared by every user: use it only on a client whose requests carry no user credentials. createNextServerAppClient checks that per request.
 */
export function nextCacheInit(options: NextCacheOptions = {}): NonNullable<ClientOptions['init']> {
  return (route): NextFetchInit => {
    const tags = route.method === 'get' && Object.hasOwn(tagsByController, route.controller) ? tagsByController[route.controller] : undefined;
    if (!tags || route.name === 'all' || !Object.hasOwn(tags, route.name)) return {};
    return { next: { tags: [tags.all, tags[route.name]], ...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }) } };
  };
}

// The tags are per controller, so a cached reply to one user's request would be served to every other user.
function hasCredentials(init: RequestInit | undefined): boolean {
  const headers = new Headers(init?.headers);
  return headers.has('cookie') || headers.has('authorization');
}

function guardedFetch(fetch: ServerAppClientOptions['fetch']): typeof globalThis.fetch {
  return (input, init) => {
    const send = fetch ?? globalThis.fetch;
    if (!hasCredentials(init)) return send(input, init);
    const uncached: NextFetchInit = { ...init, cache: 'no-store' };
    delete uncached.next;
    return send(input, uncached);
  };
}

/**
 * createServerAppClient on Next's cache: a GET without a cookie or an authorization header is tagged and cached for
 * \`revalidate\`; any call that carries one is sent with \`cache: 'no-store'\` and no tags, so no user gets another's reply.
 */
export function createNextServerAppClient(options: ServerAppClientOptions & NextCacheOptions): AppClient {
  const { revalidate, init, fetch, ...server } = options;
  const tagged = nextCacheInit({ revalidate });
  return createServerAppClient({ ...server, fetch: guardedFetch(fetch), init: (route) => ({ ...init?.(route), ...tagged(route) }) });
}

/** In a server action or route handler after a mutation: every cached GET of the controller is refetched, stale-while-revalidate with \`'max'\`. */
export function revalidateController(name: ControllerName, profile: RevalidateProfile = 'max'): void {
  revalidateTag(appTags[name].all, profile);
}

export function revalidateRoute<C extends ControllerName>(controller: C, route: TaggedRoute<C>, profile: RevalidateProfile = 'max'): void {
  const tags: Readonly<Record<string, string>> = appTags[controller];
  revalidateTag(tags[route as string], profile);
}

/** Read-your-writes, in a server action only: expires the controller's tag, so this request's render refetches. */
export function updateController(name: ControllerName): void {
  updateTag(appTags[name].all);
}
`;

/** `client.next.ts`: cache tags and revalidation for the Next.js App Router. Server-safe: no React, no Next type. */
export function emitNext(model: ClientModel, options: NextOptions = {}): string {
  const basename = options.basename ?? 'client';
  const lines = [
    companionHeader('next', model),
    "import { revalidateTag, updateTag } from 'next/cache';",
    `import type { ClientOptions } from '${options.moduleName ?? '@spinajs/client/runtime'}';`,
    `import { appTags } from './${basename}.keys.js';`,
    `import { createServerAppClient, type ServerAppClientOptions } from './${basename}.server.js';`,
    `import type { AppClient, manifestHash } from './${basename}.js';`,
    '',
    ...manifestHashCheck(model),
    '',
    '',
  ];
  return `${lines.join('\n')}${BODY}`;
}
