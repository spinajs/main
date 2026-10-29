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

// A channel key contains '/', which must be escaped as '~1' in a JSON pointer.
function channelRef(address: string): string {
  return `#/channels/${address.replace(/~/g, '~0').replace(/\//g, '~1')}`;
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

  public message(name: string, type: TypeRef): { $ref: string } {
    this.messages[name] = { name, payload: type.schema ? { $ref: this.schemaRef(type.schema) } : {} };
    return { $ref: `#/components/messages/${name}` };
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
    reply: b.message(`${key}.reply`, command.result),
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

export function manifestToAsyncApi(manifest: Manifest, options: AsyncApiOptions): AsyncApiDocument {
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
