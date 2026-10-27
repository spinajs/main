import ts from 'typescript';

/**
 * TS-internal `MappedSymbolLinks`. Only an optimisation: when a field is missing, a key-dependent value is untraceable
 * and its object fails open, so no model column is ever published on the strength of these reads alone.
 */
interface MappedSymbol extends ts.Symbol {
  links?: { syntheticOrigin?: ts.Symbol; mappedType?: { declaration?: ts.Node } };
}

export const UNTRACEABLE = Symbol('untraceable');

const MAX_HOPS = 16;

function mappedTypeNode(property: ts.Symbol, owner: ts.Type | undefined): ts.MappedTypeNode | undefined {
  const linked = (property as MappedSymbol).links?.mappedType?.declaration;
  if (linked && ts.isMappedTypeNode(linked)) return linked;
  const isMapped = owner && owner.flags & ts.TypeFlags.Object && (owner as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped;
  const declaration = isMapped ? owner.getSymbol()?.declarations?.[0] : undefined;
  return declaration && ts.isMappedTypeNode(declaration) ? declaration : undefined;
}

/** A template that names the key (`T[K]`, `Get<T, K>`) may read a member of another type; `Record`'s `T` cannot. */
function templateReadsKey(node: ts.MappedTypeNode): boolean {
  const key = node.typeParameter.name.text;
  const visit = (child: ts.Node): boolean => (ts.isIdentifier(child) && child.text === key) || !!ts.forEachChild(child, visit);
  return !!node.type && visit(node.type);
}

/**
 * The declaration a property's value comes from: its own, or for a mapped property without one (a key-remapping `as` clause,
 * a literal key union) the member it maps. `undefined` is a value that reads no member; UNTRACEABLE is a member read
 * whose member is unknown, which may be a model column under a new name.
 */
export function valueDeclaration(property: ts.Symbol, owner?: ts.Type, hops = 0): ts.Declaration | undefined | typeof UNTRACEABLE {
  const own = property.valueDeclaration ?? property.declarations?.[0];
  if (own) return own;
  const node = mappedTypeNode(property, owner);
  if (node && !templateReadsKey(node)) return undefined;
  const origin = (property as MappedSymbol).links?.syntheticOrigin;
  return origin && hops < MAX_HOPS ? valueDeclaration(origin, undefined, hops + 1) : UNTRACEABLE;
}
