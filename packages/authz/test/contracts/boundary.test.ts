import * as chai from 'chai';
import 'mocha';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const expect = chai.expect;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACTS_DIR = join(PKG_ROOT, 'src', 'contracts');
const CONDITIONS_CONTRACTS = join(PKG_ROOT, 'src', 'conditions', 'contracts.ts');
const ALLOWED_PACKAGES = ['@spinajs/authn/contracts', '@spinajs/di', '@spinajs/exceptions'];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = (): string[] => [...listTs(CONTRACTS_DIR), CONDITIONS_CONTRACTS];

// Relative targets are checked without extension: any file under contracts/ or conditions/contracts.
function isContractTarget(target: string): boolean {
  const rel = relative(CONTRACTS_DIR, target);
  return (!rel.startsWith('..') && !isAbsolute(rel)) || target === CONDITIONS_CONTRACTS.replace(/\.ts$/, '');
}

function specifiersOf(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  return [...info.importedFiles, ...info.referencedFiles, ...info.typeReferenceDirectives].map((f) => f.fileName);
}

describe('authz contract files boundary', () => {
  it('scans the contract files', () => {
    const all = files().flatMap(specifiersOf);
    expect(files().length).to.be.greaterThan(5);
    expect(all).to.include('@spinajs/di');
    expect(all).to.include('./principal.js');
  });

  it('imports only contract files and allowed packages', () => {
    const bad: string[] = [];
    for (const file of files()) {
      for (const spec of specifiersOf(file)) {
        const ok = spec.startsWith('.') ? isContractTarget(resolve(dirname(file), spec.replace(/\.js$/, ''))) : ALLOWED_PACKAGES.includes(spec);
        if (!ok) bad.push(`${relative(PKG_ROOT, file)}: ${spec}`);
      }
    }
    expect(bad).to.deep.eq([]);
  });

  it('never imports the @spinajs/authn root', () => {
    const roots = files().flatMap((f) => specifiersOf(f).filter((s) => s === '@spinajs/authn'));
    expect(roots).to.deep.eq([]);
  });

  it('declares no DI registration, lifetime decorator or container call', () => {
    const bad: string[] = [];
    for (const f of files()) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (ts.isDecorator(n)) bad.push(`${relative(PKG_ROOT, f)}: decorator ${n.expression.getText(sf)}`);
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'DI') bad.push(`${relative(PKG_ROOT, f)}: ${n.expression.getText(sf)}`);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bad).to.deep.eq([]);
  });
});
