import ts from 'typescript';
import type { CliCommandEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, literalValue, type DecoratorInfo } from '../decorators.js';

interface CommandMeta {
  nameAndArgs?: string;
  description?: string;
  parent?: string;
}

// Positional form: (value, required, description); object form: ({ [key], description }).
function describedItem<K extends string>(d: DecoratorInfo, key: K, ctx: ExtractorContext): { [P in K]: string } & { description?: string } {
  const v = literalValue(d.args[0], ctx);
  const obj = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const name = typeof v === 'string' ? v : String(obj[key] ?? '');
  const description = typeof v === 'string' ? literalValue(d.args[2], ctx) : obj.description;
  return { [key]: name, ...(typeof description === 'string' && description ? { description } : {}) } as { [P in K]: string } & { description?: string };
}

function commandMeta(d: DecoratorInfo, ctx: ExtractorContext): CommandMeta {
  const first = literalValue(d.args[0], ctx);
  if (typeof first === 'string') return { nameAndArgs: first, description: literalValue(d.args[1], ctx) as string | undefined };
  return (first ?? {}) as CommandMeta;
}

export const extractCommands: Extractor<CliCommandEntry> = (ctx, file) => {
  const out: CliCommandEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const cmd = findDecorator(st, 'Command');
    if (!cmd || !ctx.isSubclassOf(st, 'CliCommand')) continue;
    const meta = commandMeta(cmd, ctx);
    const decs = decoratorsOf(st);
    out.push({
      name: (meta.nameAndArgs ?? st.name.text).split(/\s+/)[0],
      className: st.name.text,
      ...(meta.description ? { description: meta.description } : {}),
      options: decs.filter((d) => d.name === 'Option').map((d) => describedItem(d, 'flags', ctx)),
      arguments: decs.filter((d) => d.name === 'Argument').map((d) => describedItem(d, 'name', ctx)),
      ...(meta.parent ? { parent: meta.parent } : {}),
      source: ctx.sourceRef(st),
    });
  }
  return out;
};
