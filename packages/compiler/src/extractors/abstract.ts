import ts from 'typescript';

/** Abstract classes are bases: discovery never lists them, and nothing can instantiate one. */
export const isAbstractClass = (node: ts.ClassDeclaration): boolean => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Abstract) !== 0;
