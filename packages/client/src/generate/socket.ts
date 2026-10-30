import type { SocketControllerEntry } from '@spinajs/manifest';
import { propertyKey, type TypeContext } from './ts-type.js';

export function contractName(prefix: string, className: string): string {
  const words = (prefix || className).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1)).join('');
  return `${/^[0-9]/.test(camel) ? '_' : ''}${camel}Contract`;
}

export function emitContract(controller: SocketControllerEntry, ctx: TypeContext): string {
  const commands = controller.commands.map((c) => {
    const result = ctx.typeOf(c.result);
    return `${propertyKey(c.name)}: [${ctx.typeOf(c.payload)}, ${c.stream ? `AsyncIterable<${result}>` : result}]`;
  });
  const events = controller.events.map((e) => `${propertyKey(e.name)}: ${ctx.typeOf(e.payload)}`);
  return [
    `export const ${contractName(controller.prefix, controller.className)} = defineContract<{`,
    `  commands: { ${commands.join('; ')} };`,
    `  events: { ${events.join('; ')} };`,
    '}>();',
  ].join('\n');
}
