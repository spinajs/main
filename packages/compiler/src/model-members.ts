import ts from 'typescript';
import { decoratorsOf, type DecoratorInfo } from './decorators.js';
import { extendsFrameworkClass, isDeclaredIn } from './schema/framework-members.js';

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
