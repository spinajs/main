import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Strict identity: readonly, optionality and union members must all match.
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

const SRC_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src', 'contracts');

export interface MemberShape {
  name: string;
  modifiers: string[];
  optional: boolean;
  params: string[] | null;
  doc: string;
}

export interface ClassShape {
  base: string | null;
  doc: string;
  members: MemberShape[];
}

// Line breaks inside a doc comment become single spaces, so a phrase may wrap.
const docText = (n: ts.Node, sf: ts.SourceFile) =>
  ts
    .getJSDocCommentsAndTags(n)
    .map((d) => d.getText(sf).replace(/[ \t]*\r?\n[ \t]*\*(?!\/)[ \t]*/g, ' '))
    .join(' ');

const parse = (file: string) => ts.createSourceFile(file, readFileSync(join(SRC_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);

export function classMembers(file: string): Record<string, ClassShape> {
  const sf = parse(file);
  const out: Record<string, ClassShape> = {};
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || !n.name) return;
    const heritage = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    out[n.name.text] = {
      base: heritage ? heritage.types[0].expression.getText(sf) : null,
      doc: docText(n, sf),
      members: n.members.map((m) => ({
        name: m.name ? m.name.getText(sf) : '',
        modifiers: (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).map((x) => x.getText(sf)),
        optional: (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && !!m.questionToken,
        params: ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
        doc: docText(m, sf),
      })),
    };
  });
  return out;
}

/** Docs of every top-level declaration (type alias, interface, class) by name. */
export function declarationDocs(file: string): Record<string, string> {
  const sf = parse(file);
  const out: Record<string, string> = {};
  sf.forEachChild((n) => {
    if ((ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n)) && n.name) out[n.name.text] = docText(n, sf);
  });
  return out;
}

/** Docs of the members of an interface or of an object type literal alias. */
export function memberDocs(file: string, name: string): Record<string, string> {
  const sf = parse(file);
  const out: Record<string, string> = {};
  const visit = (node: ts.Node) => {
    if (ts.isPropertySignature(node) && node.name) out[node.name.getText(sf)] = [out[node.name.getText(sf)], docText(node, sf)].filter(Boolean).join(' ');
    node.forEachChild(visit);
  };
  sf.forEachChild((n) => {
    if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name.text === name) visit(n);
  });
  return out;
}

export function unionLiterals(file: string, name: string): string[] {
  const sf = parse(file);
  let out: string[] = [];
  sf.forEachChild((n) => {
    if (!ts.isTypeAliasDeclaration(n) || n.name.text !== name || !ts.isUnionTypeNode(n.type)) return;
    out = n.type.types.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : `<${t.getText(sf)}>`));
  });
  return out;
}

export const shapeOf = (c: Record<string, ClassShape>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { base: v.base, members: v.members.map(({ doc: _doc, ...rest }) => rest) }]));
export const docOf = (members: MemberShape[], name: string) => members.find((m) => m.name === name)?.doc ?? '';
