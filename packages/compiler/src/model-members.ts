import ts from 'typescript';
import { decoratorsOf, type DecoratorInfo } from './decorators.js';
import { baseClassOf, extendsFrameworkClass, isDeclaredIn } from './schema/framework-members.js';

export const ORM = '@spinajs/orm';
export const RELATION_DECORATORS = new Set(['BelongsTo', 'ForwardBelongsTo', 'HasMany', 'HasManyToMany']);
const COMPUTED_DECORATORS = new Set(['Virtual', 'Query', 'Historical']);

export interface ModelMember {
  name: string;
  symbol: ts.Symbol;
  declaration: ts.Declaration;
  /** Declared type, nullish members included. */
  type: ts.Type;
  kind: 'column' | 'relation' | 'computed';
  decorators: DecoratorInfo[];
  /** `@Hidden`: a real column or relation that `dehydrate()` never emits. Always false for members read from declaration files. */
  hidden: boolean;
  optional: boolean;
}

export const isModelType = (checker: ts.TypeChecker, type: ts.Type): boolean => !!(type.flags & ts.TypeFlags.Object) && extendsFrameworkClass(checker, type, 'ModelBase', ORM);

/** ModelBase's own getters (Container, ModelDescriptor, ...) are ORM plumbing; columns start at its subclasses. */
function isModelBaseMember(declaration: ts.Declaration): boolean {
  const owner = declaration.parent;
  return ts.isClassLike(owner) && owner.name?.text === 'ModelBase' && isDeclaredIn(declaration, ORM);
}

export const isRelationType = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  extendsFrameworkClass(checker, type, 'Relation', ORM) || extendsFrameworkClass(checker, type, 'SingleRelation', ORM);

function isPublicData(property: ts.Symbol, declaration: ts.Declaration): boolean {
  if (property.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Signature)) return false;
  // A get-only accessor is computed: hydration cannot write it, so it is no column.
  if (property.flags & ts.SymbolFlags.GetAccessor && !(property.flags & ts.SymbolFlags.SetAccessor)) return false;
  const name = ts.getNameOfDeclaration(declaration);
  if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) return false;
  return !(ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static));
}

/** An accessor pair may carry its decorators on either half. */
const decoratorsOfSymbol = (property: ts.Symbol): DecoratorInfo[] =>
  (property.declarations ?? []).flatMap((declaration) => (ts.canHaveDecorators(declaration) ? decoratorsOf(declaration) : []));

function classify(checker: ts.TypeChecker, type: ts.Type, decorators: DecoratorInfo[]): ModelMember['kind'] {
  if (decorators.some((d) => RELATION_DECORATORS.has(d.name)) || isRelationType(checker, checker.getNonNullableType(type))) return 'relation';
  return decorators.some((d) => COMPUTED_DECORATORS.has(d.name)) ? 'computed' : 'column';
}

/**
 * The one place that decides what a model's members are, shared by the `models` manifest section and the model schema:
 * public data members of the class and its bases below ModelBase, own members first, writable accessors included.
 */
export function modelMembers(checker: ts.TypeChecker, model: ts.Type): ModelMember[] {
  const out: ModelMember[] = [];
  for (const property of checker.getPropertiesOfType(model)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration || !isPublicData(property, declaration) || isModelBaseMember(declaration)) continue;
    const type = checker.getTypeOfSymbolAtLocation(property, declaration);
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length) continue;
    const decorators = decoratorsOfSymbol(property);
    out.push({
      name: property.name,
      symbol: property,
      declaration,
      type,
      kind: classify(checker, type, decorators),
      decorators,
      hidden: decorators.some((d) => d.name === 'Hidden'),
      optional: !!(property.flags & ts.SymbolFlags.Optional),
    });
  }
  return out;
}

/** The first class from the model up to ModelBase that is read from a declaration file, where decorators are gone. */
export function declarationFileClass(checker: ts.TypeChecker, model: ts.Type): ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Type | undefined = model; current; current = baseClassOf(checker, current)) {
    const declaration = current.getSymbol()?.declarations?.find(ts.isClassLike);
    if (!declaration || (declaration.name?.text === 'ModelBase' && isDeclaredIn(declaration, ORM))) return undefined;
    if (declaration.getSourceFile().isDeclarationFile) return declaration;
  }
  return undefined;
}

/** How a property of a non-model type (`Partial<M>`, an interface extending M) is published when a model class declares it. */
export type ModelOrigin =
  | { kind: 'none' }
  | { kind: 'omitted' }
  | { kind: 'member'; member: ModelMember }
  | { kind: 'opaque'; model: ts.Type; declarationFile: ts.ClassLikeDeclaration };

const membersByModel = new WeakMap<ts.Type, ModelMember[]>();

function cachedMembers(checker: ts.TypeChecker, model: ts.Type): ModelMember[] {
  let members = membersByModel.get(model);
  if (!members) membersByModel.set(model, (members = modelMembers(checker, model)));
  return members;
}

function declaringModel(checker: ts.TypeChecker, declaration: ts.Declaration): ts.Type | undefined {
  const owner = declaration.parent;
  const symbol = ts.isClassLike(owner) ? checker.getTypeAtLocation(owner).getSymbol() : undefined;
  const model = symbol && checker.getDeclaredTypeOfSymbol(symbol);
  return model && isModelType(checker, model) ? model : undefined;
}

/**
 * Mapped types copy a model's member declarations but not its class, so the model rules are applied by member origin:
 * a member of a declaration-file model makes the whole object opaque, an in-program one is published only when `modelMembers` lists it unhidden.
 */
export function modelOrigin(checker: ts.TypeChecker, declaration: ts.Declaration): ModelOrigin {
  const model = declaringModel(checker, declaration);
  if (!model) return { kind: 'none' };
  if (isModelBaseMember(declaration)) return { kind: 'omitted' };
  const declarationFile = declarationFileClass(checker, model);
  if (declarationFile) return { kind: 'opaque', model, declarationFile };
  const member = cachedMembers(checker, model).find((candidate) => candidate.symbol.declarations?.includes(declaration));
  return member && !member.hidden && member.kind !== 'computed' ? { kind: 'member', member } : { kind: 'omitted' };
}
