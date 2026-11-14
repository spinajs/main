import { publishedManifest } from '@spinajs/manifest';
import type { Manifest, SocketCommandEntry, TypeRef } from '@spinajs/manifest';

export interface AsyncApiOptions {
  title: string;
  version: string;
  serverUrl?: string;
  /** Schema `$id` of the error body; when present in the manifest it is added as an `error` reply message */
  errorSchemaId?: string;
}

type Dict = Record<string, unknown>;

export type AsyncApiDocument = {
  asyncapi: '3.0.0';
  info: { title: string; version: string; 'x-spinajs-manifest-hash': string };
  servers?: Record<string, { host: string; protocol: string }>;
  channels: Record<string, Dict>;
  operations: Record<string, Dict>;
  components: { schemas: Record<string, unknown>; messages: Record<string, unknown> };
};

// Must match WIRE_EVENTS in packages/http-socket-common/src/protocol.ts (pinned by a test).
const STREAM_FRAMES = ['chunk', 'end', 'fail'];

// Keys whose children are a name -> schema map: the names are user data, not keywords.
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

function componentName(id: string): string {
  return id
    .replace(/\.json$/, '')
    .split('/')
    .pop()!
    .replace(/[^A-Za-z0-9_]/g, '_');
}

// A `$ref` is a URI fragment, which readers percent-decode before resolving the pointer.
const pointerToken = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1').replace(/%/g, '%25');

// A channel key contains '/', which must be escaped as '~1' in a JSON pointer.
function channelRef(address: string): string {
  return `#/channels/${pointerToken(address)}`;
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function commandExtensions(command: SocketCommandEntry): Dict {
  return {
    ...(command.options.idempotent !== undefined ? { 'x-idempotent': command.options.idempotent } : {}),
    ...(command.options.ordered !== undefined ? { 'x-ordered': command.options.ordered } : {}),
    ...(command.options.timeoutMs !== undefined ? { 'x-timeout-ms': command.options.timeoutMs } : {}),
    ...(command.access?.length ? { 'x-authz-permission': [...command.access] } : {}),
  };
}

class Builder {
  public readonly schemas: Dict = {};
  public readonly messages: Dict = {};

  constructor(private readonly manifest: Manifest) {}

  /** `fields`: the permission whose field set redacts the payload; its properties become optional and marked (G16). */
  public message(name: string, type: TypeRef, fields?: string): { $ref: string } {
    const payload = type.schema ? { $ref: this.schemaRef(type.schema) } : {};
    this.messages[name] = { name, payload: fields === undefined ? payload : this.redactable(payload, fields, 0) };
    return { $ref: `#/components/messages/${pointerToken(name)}` };
  }

  // A component is copied inline, so commands without filtering keep it as is.
  private redactable(schema: unknown, permission: string, depth: number): unknown {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return schema;
    const node = schema as Dict;
    if (typeof node.$ref === 'string') return this.redactable(this.schemas[node.$ref.replace('#/components/schemas/', '')], permission, depth + 1);
    const { required: _required, ...out } = node;
    if (node.items && typeof node.items === 'object') out.items = this.redactable(node.items, permission, depth + 1);
    if (node.properties && typeof node.properties === 'object') {
      out.properties = Object.fromEntries(Object.entries(node.properties as Dict).map(([key, p]) => [key, p && typeof p === 'object' ? { ...(p as Dict), 'x-spina-fields': permission } : p]));
    }
    return out;
  }

  public hasSchema(id: string): boolean {
    return id in this.manifest.schemas;
  }

  private schemaRef(id: string): string {
    const name = componentName(id);
    if (!(name in this.schemas)) {
      this.schemas[name] = {};
      this.schemas[name] = this.rewrite(this.manifest.schemas[id], false);
    }
    return `#/components/schemas/${name}`;
  }

  private rewrite(schema: unknown, nameMap: boolean): unknown {
    if (Array.isArray(schema)) return schema.map((item) => this.rewrite(item, false));
    if (!schema || typeof schema !== 'object') return schema;

    const out: Dict = {};
    for (const [key, value] of Object.entries(schema as Dict)) {
      if (!nameMap && (key === '$id' || key === '$schema' || key.startsWith('x-'))) continue;
      if (!nameMap && key === '$ref' && typeof value === 'string' && this.hasSchema(value)) {
        out[key] = this.schemaRef(value);
      } else {
        out[key] = this.rewrite(value, !nameMap && NAME_MAPS.has(key));
      }
    }
    return out;
  }
}

function addCommand(b: Builder, prefix: string, command: SocketCommandEntry, errorType: TypeRef | undefined, channels: Record<string, Dict>, operations: Record<string, Dict>): void {
  const address = `socket/${prefix}/${command.name}`;
  const key = `${prefix}.${command.name}`;
  const chan = channelRef(address);
  const replies = ['reply'];
  const messages: Dict = {
    request: b.message(`${key}.request`, command.payload),
    reply: b.message(`${key}.reply`, command.result, command.fields && command.access?.length ? command.access[0] : undefined),
  };
  if (errorType) {
    messages.error = b.message(`${key}.error`, errorType);
    replies.push('error');
  }
  channels[address] = { address, messages };

  operations[`${key}.send`] = { action: 'send', channel: { $ref: chan }, messages: [{ $ref: `${chan}/messages/request` }], ...commandExtensions(command) };
  operations[`${key}.receive`] = {
    action: 'receive',
    channel: { $ref: chan },
    messages: replies.map((name) => ({ $ref: `${chan}/messages/${name}` })),
    ...(command.stream ? { 'x-spinajs-stream': true, 'x-spinajs-stream-frames': STREAM_FRAMES } : {}),
  };
}

interface SignalChannel { workflow: string; signal: string; permission?: string; version: number }

/**
 * Workflow and signal names may contain '/', '.', '{' or '}', which separate the address, the message name and the operation
 * key or make a channel parameter. Escaping them (`/` is `$2f;`) keeps every pair apart: `a/b` + `c` and `a` + `b/c` get two
 * channels. Not percent-encoding: `@asyncapi/parser` decodes `%` in keys and then misses them.
 */
const segment = (name: string): string => name.replace(/[^A-Za-z0-9_:-]/gu, (c) => `$${c.codePointAt(0)!.toString(16)};`);

/** Versions share a channel: the newest documents the permission, and within one version the entry that declares one. */
function signalChannels(manifest: Manifest): SignalChannel[] {
  const channels = new Map<string, SignalChannel>();
  for (const w of manifest.workflows ?? []) {
    for (const s of w.signals) {
      // '*' records a computed name; a literal with '#' or '*' is one signal() refuses.
      if (/[#*]/.test(s.name)) continue;
      const key = `${w.name}\u0000${s.name}`;
      const known = channels.get(key);
      if (!known || w.version > known.version || (w.version === known.version && !known.permission && s.permission)) {
        channels.set(key, { workflow: w.name, signal: s.name, permission: s.permission, version: w.version });
      }
    }
  }
  return [...channels.values()];
}

function addWorkflowSignals(b: Builder, manifest: Manifest, channels: Record<string, Dict>, operations: Record<string, Dict>): void {
  for (const s of signalChannels(manifest)) {
    const id = `${segment(s.workflow)}.${segment(s.signal)}`;
    const address = `workflow/${segment(s.workflow)}/${segment(s.signal)}`;
    const chan = channelRef(address);
    channels[address] = {
      address,
      messages: { signal: b.message(`workflow.${id}`, { text: 'unknown' }) },
      'x-spinajs-workflow': s.workflow,
      ...(s.permission ? { 'x-spinajs-permission': s.permission } : {}),
    };
    operations[`workflow.${id}.send`] = { action: 'send', channel: { $ref: chan }, messages: [{ $ref: `${chan}/messages/signal` }] };
  }
}

export function manifestToAsyncApi(fullManifest: Manifest, options: AsyncApiOptions): AsyncApiDocument {
  const manifest = publishedManifest(fullManifest);
  const b = new Builder(manifest);
  const channels: Record<string, Dict> = {};
  const operations: Record<string, Dict> = {};
  const errorType: TypeRef | undefined = options.errorSchemaId && b.hasSchema(options.errorSchemaId) ? { text: 'Error', schema: options.errorSchemaId } : undefined;

  for (const controller of [...manifest.socketControllers].sort((x, y) => x.prefix.localeCompare(y.prefix))) {
    for (const command of [...controller.commands].sort((x, y) => x.name.localeCompare(y.name))) {
      addCommand(b, controller.prefix, command, errorType, channels, operations);
    }

    for (const event of [...controller.events].sort((x, y) => x.name.localeCompare(y.name))) {
      const address = `socket/${controller.prefix}/events/${event.name}`;
      const chan = channelRef(address);
      channels[address] = { address, messages: { event: b.message(`${controller.prefix}.events.${event.name}`, event.payload) } };
      operations[`${controller.prefix}.events.${event.name}.receive`] = { action: 'receive', channel: { $ref: chan }, messages: [{ $ref: `${chan}/messages/event` }] };
    }
  }

  for (const msg of [...manifest.queueMessages].sort((x, y) => x.className.localeCompare(y.className))) {
    const address = `queue/${msg.className}`;
    const chan = channelRef(address);
    channels[address] = {
      address,
      messages: { message: b.message(msg.className, msg.payload) },
      'x-spinajs-kind': msg.kind,
      'x-spinajs-routing': `queue.routing.${msg.className}`,
    };
    operations[`queue.${msg.className}.send`] = { action: 'send', channel: { $ref: chan }, messages: [{ $ref: `${chan}/messages/message` }] };
  }

  addWorkflowSignals(b, manifest, channels, operations);

  const serverUrl = options.serverUrl;
  return {
    asyncapi: '3.0.0',
    info: { title: options.title, version: options.version, 'x-spinajs-manifest-hash': manifest.hash },
    ...(serverUrl ? { servers: { default: { host: serverUrl.replace(/^\w+:\/\//, ''), protocol: serverUrl.split(':')[0] } } } : {}),
    channels: sorted(channels),
    operations: sorted(operations),
    components: { schemas: sorted(b.schemas), messages: sorted(b.messages) },
  };
}
