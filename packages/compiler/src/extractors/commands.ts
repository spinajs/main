import { isAbstractClass } from './abstract.js';
import ts from 'typescript';
import type { CliCommandEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, literalValue, type DecoratorInfo } from '../decorators.js';

interface CommandMeta {
  nameAndArgs?: string;
  description?: string;
  parent?: string;
}

// Positional form: (value, required, description); object form: ({ <key>, description }).
function describedItem(d: DecoratorInfo, ctx: ExtractorContext): { value: string; description?: string } {
  const v = literalValue(d.args[0], ctx);
  const obj = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const value = typeof v === 'string' ? v : '';
  const description = typeof v === 'string' ? literalValue(d.args[2], ctx) : obj.description;
  return { value, ...(typeof description === 'string' && description ? { description } : {}) };
}

function optionOf(d: DecoratorInfo, ctx: ExtractorContext): CliCommandEntry['options'][number] {
  const { value, description } = describedItem(d, ctx);
  const obj = literalValue(d.args[0], ctx) as { flags?: unknown } | string | undefined;
  const flags = typeof obj === 'object' && typeof obj.flags === 'string' ? obj.flags : value;
  return { flags, ...(description ? { description } : {}) };
}

function argumentOf(d: DecoratorInfo, ctx: ExtractorContext): CliCommandEntry['arguments'][number] {
  const { value, description } = describedItem(d, ctx);
  const obj = literalValue(d.args[0], ctx) as { name?: unknown } | string | undefined;
  const name = typeof obj === 'object' && typeof obj.name === 'string' ? obj.name : value;
  return { name, ...(description ? { description } : {}) };
}

function commandMeta(d: DecoratorInfo, ctx: ExtractorContext): CommandMeta {
  const first = literalValue(d.args[0], ctx);
  if (typeof first === 'string') return { nameAndArgs: first, description: literalValue(d.args[1], ctx) as string | undefined };
  return typeof first === 'object' && first !== null ? first : {};
}

export const extractCommands: Extractor<CliCommandEntry> = (ctx, file) => {
  const out: CliCommandEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isClassDeclaration(st) || !st.name || isAbstractClass(st)) continue;
    const cmd = findDecorator(st, 'Command');
    if (!cmd || !ctx.isSubclassOf(st, 'CliCommand')) continue;
    const meta = commandMeta(cmd, ctx);
    const decs = decoratorsOf(st);
    out.push({
      name: (meta.nameAndArgs ?? st.name.text).split(/\s+/)[0],
      className: st.name.text,
      ...(meta.description ? { description: meta.description } : {}),
      options: decs.filter((d) => d.name === 'Option').map((d) => optionOf(d, ctx)),
      arguments: decs.filter((d) => d.name === 'Argument').map((d) => argumentOf(d, ctx)),
      ...(meta.parent ? { parent: meta.parent } : {}),
      source: ctx.sourceRef(st),
    });
  }
  return out;
};
