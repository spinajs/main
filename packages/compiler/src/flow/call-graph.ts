import ts from 'typescript';
import { findDecorator } from '../decorators.js';

export type FunctionLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.GetAccessorDeclaration | ts.ConstructorDeclaration;
export type EdgeVia = 'direct' | 'injected' | 'resolve' | 'implementation' | 'reference';
export interface CallTarget {
  readonly fn: FunctionLike;
  readonly via: EdgeVia;
}

/**
 * `opaque`: the program does not determine the callee (a callback parameter, a function held in a property or
 * variable of function type, an abstract or interface member nothing implements, an untyped callee). `external`:
 * it is declared in a dependency's declaration file, which the pass does not follow. A language built-in is neither.
 */
export interface ResolvedCall {
  readonly targets: readonly CallTarget[];
  readonly opaque: boolean;
  readonly external: boolean;
}

const NONE: ResolvedCall = { targets: [], opaque: false, external: false };
const OPAQUE: ResolvedCall = { targets: [], opaque: true, external: false };
const EXTERNAL: ResolvedCall = { targets: [], opaque: false, external: true };
const INJECT_DECORATORS = ['Autoinject', 'Inject'];
/** The members of `Function.prototype` that run, or prepare to run, their receiver. */
const FUNCTION_MEMBERS = new Set(['call', 'apply', 'bind']);
const CHOICE_OPERATORS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);

export const isFunctionLike = (d: ts.Node | undefined): d is FunctionLike =>
  d !== undefined && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isFunctionExpression(d) || ts.isArrowFunction(d) || ts.isGetAccessorDeclaration(d) || ts.isConstructorDeclaration(d));
const hasModifier = (d: ts.Declaration, flag: ts.ModifierFlags): boolean => (ts.getCombinedModifierFlags(d) & flag) !== 0;
const isAbstract = (d: ts.Declaration): boolean => hasModifier(d, ts.ModifierFlags.Abstract);
/** A property whose value a subclass or an implementing class supplies, possibly through a getter. */
const isDeferredProperty = (d: ts.Declaration): boolean => ts.isPropertySignature(d) || (ts.isPropertyDeclaration(d) && isAbstract(d));

const memberName = (d: ts.Declaration): string | undefined => {
  const named = ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isGetAccessorDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d);
  return named && !ts.isComputedPropertyName(d.name) ? d.name.getText() : undefined;
};

const unwrap = (expr: ts.Expression): ts.Expression => {
  let out = expr;
  while (ts.isParenthesizedExpression(out) || ts.isNonNullExpression(out)) out = out.expression;
  return out;
};

const implementedBy = (d: ts.Declaration): ts.ExpressionWithTypeArguments[] =>
  ts.isClassLike(d) ? (d.heritageClauses ?? []).filter((c) => c.token === ts.SyntaxKind.ImplementsKeyword).flatMap((c) => [...c.types]) : [];

const bySource =(a: ts.Node, b: ts.Node): number => a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) || a.pos - b.pos;

function addTargets(into: CallTarget[], more: readonly CallTarget[]): CallTarget[] {
  for (const target of more) if (!into.some((t) => t.fn === target.fn)) into.push(target);
  return into;
}

function merge(all: readonly ResolvedCall[]): ResolvedCall {
  const targets = all.reduce<CallTarget[]>((into, r) => addTargets(into, r.targets), []);
  return { targets, opaque: all.some((r) => r.opaque), external: all.some((r) => r.external) };
}

export class CallGraph {
  private readonly checker: ts.TypeChecker;
  private readonly own: ReadonlySet<ts.SourceFile>;
  /** A class, interface or `@Injectable` token to the package's concrete classes that stand in for it. */
  private readonly implementations = new Map<ts.Symbol, ts.ClassDeclaration[]>();
  private readonly resolved = new Map<ts.Node, ResolvedCall>();

  constructor(
    private readonly program: ts.Program,
    files: readonly ts.SourceFile[],
  ) {
    this.checker = program.getTypeChecker();
    this.own = new Set(files);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && !isAbstract(node)) this.index(node);
      ts.forEachChild(node, visit);
    };
    files.forEach(visit);
  }

  resolve(call: ts.CallExpression | ts.NewExpression): ResolvedCall {
    let out = this.resolved.get(call);
    if (out === undefined) {
      out = this.resolveNow(call);
      this.resolved.set(call, out);
    }
    return out;
  }

  /** The program function an expression names without calling it. */
  referenced(expr: ts.Expression): readonly CallTarget[] {
    const decl = this.symbolOf(expr)?.valueDeclaration;
    if (decl === undefined) return [];
    // `const f = () => ...` and `private f = () => ...` name the function they are initialised with.
    const fn = (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && isFunctionLike(decl.initializer) ? decl.initializer : decl;
    if (!ts.isFunctionDeclaration(fn) && !ts.isMethodDeclaration(fn) && !ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return [];
    return this.bodies(fn, 'reference');
  }

  /** What a function value handed on runs: its bodies when the program names it, else opaque or external as a call to it would be. */
  handed(expr: ts.Expression): ResolvedCall {
    // A function written inline is analysed where it stands.
    if (isFunctionLike(expr)) return NONE;
    const targets = this.referenced(expr);
    if (targets.length > 0) return { targets, opaque: false, external: false };
    if (this.checker.getNonNullableType(this.checker.getTypeAtLocation(expr)).getCallSignatures().length === 0) return NONE;
    const decl = this.symbolOf(expr)?.valueDeclaration;
    // A callback parameter, a function-typed property or variable, the result of a call: nothing says what it runs.
    return decl === undefined || this.own.has(decl.getSourceFile()) ? OPAQUE : this.outside(decl);
  }

  /** The expressions a call is handed and may run: its arguments, and the receiver of a built-in `f.call`, `f.apply` or `f.bind`. */
  handedTo(call: ts.CallExpression | ts.NewExpression): readonly ts.Expression[] {
    const args = [...(call.arguments ?? [])];
    const callee = call.expression;
    const resolved = this.resolve(call);
    const builtIn = resolved.targets.length === 0 && !resolved.opaque && !resolved.external;
    return builtIn && ts.isPropertyAccessExpression(callee) && FUNCTION_MEMBERS.has(callee.name.text) ? [callee.expression, ...args] : args;
  }

  /** The getter a property read runs, when the package declares it. */
  getter(access: ts.PropertyAccessExpression): readonly CallTarget[] {
    const via = this.viaOf(access);
    const targets: CallTarget[] = [];
    // A read on a union has one declaration per member.
    for (const decl of this.checker.getSymbolAtLocation(access.name)?.declarations ?? []) {
      if (ts.isGetAccessorDeclaration(decl)) addTargets(targets, this.bodies(decl, via));
      else if (isDeferredProperty(decl)) addTargets(targets, this.standInTargets(decl, via, true));
    }
    return targets;
  }

  /** `Class.method`, `Class.constructor` or `function`, for path printing. */
  nameOf(fn: FunctionLike): string {
    const holder = (ts.isVariableDeclaration(fn.parent) || ts.isPropertyDeclaration(fn.parent)) && fn.parent.initializer === fn ? fn.parent : fn;
    const cls = ts.isClassLike(holder.parent) ? holder.parent.name?.text : undefined;
    const own = this.ownName(holder);
    return cls === undefined ? own : `${cls}.${own}`;
  }

  private ownName(holder: FunctionLike | ts.VariableDeclaration | ts.PropertyDeclaration): string {
    if (ts.isConstructorDeclaration(holder)) return 'constructor';
    const name = ts.isArrowFunction(holder) ? undefined : holder.name;
    return name !== undefined && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) ? name.text : '<anonymous>';
  }

  private resolveNow(call: ts.CallExpression | ts.NewExpression): ResolvedCall {
    const decls = this.calleeDeclarations(call);
    if (decls.length === 0) return ts.isNewExpression(call) ? this.implicitConstructor(call) : OPAQUE;
    const via = ts.isNewExpression(call) ? 'direct' : this.viaOf(call.expression);
    return merge(decls.map((decl) => this.resolveDeclaration(decl, via)));
  }

  private resolveDeclaration(decl: ts.SignatureDeclaration, via: EdgeVia): ResolvedCall {
    if (!this.own.has(decl.getSourceFile())) return this.outside(decl);
    // A function type: a callback parameter, a member or a variable typed as a function.
    if (!isFunctionLike(decl) && !ts.isMethodSignature(decl)) return OPAQUE;
    const targets = this.bodies(decl, via);
    return { targets, opaque: targets.length === 0, external: false };
  }

  /**
   * The checker resolves a call to one signature. A union callee may run any member's, and a choice whose operands the
   * checker reduced to one type (`c ? new A() : new B()` with A and B alike) may run either operand's.
   */
  private calleeDeclarations(call: ts.CallExpression | ts.NewExpression): ts.SignatureDeclaration[] {
    const out = new Set<ts.SignatureDeclaration>();
    const picked = this.checker.getResolvedSignature(call)?.getDeclaration();
    if (picked !== undefined) out.add(picked);
    const types = ts.isCallExpression(call) ? this.calleeTypes(call.expression) : [];
    for (const signature of types.flatMap((type) => type.getCallSignatures())) {
      const decl: ts.SignatureDeclaration | undefined = signature.getDeclaration();
      if (decl !== undefined) out.add(decl);
    }
    return [...out].sort(bySource);
  }

  private calleeTypes(callee: ts.Expression): ts.Type[] {
    const target = unwrap(callee);
    const types = ts.isPropertyAccessExpression(target)
      ? this.choices(target.expression).flatMap((receiver) => this.memberType(receiver, target))
      : this.choices(target).map((operand) => this.checker.getTypeAtLocation(operand));
    types.push(this.checker.getTypeAtLocation(callee));
    return types.flatMap((type) => {
      const value = this.checker.getNonNullableType(type);
      return value.isUnion() ? value.types : [value];
    });
  }

  private memberType(receiver: ts.Expression, access: ts.PropertyAccessExpression): ts.Type[] {
    const property = this.checker.getNonNullableType(this.checker.getTypeAtLocation(receiver)).getProperty(access.name.text);
    return property === undefined ? [] : [this.checker.getTypeOfSymbolAtLocation(property, access)];
  }

  /** What an expression may evaluate to: each operand of a choice, through parentheses and `const` bindings. */
  private choices(expr: ts.Expression, seen = new Set<ts.Node>()): ts.Expression[] {
    const value = unwrap(expr);
    if (seen.has(value)) return [];
    seen.add(value);
    if (ts.isConditionalExpression(value)) return [...this.choices(value.whenTrue, seen), ...this.choices(value.whenFalse, seen)];
    if (ts.isBinaryExpression(value) && CHOICE_OPERATORS.has(value.operatorToken.kind)) return [...this.choices(value.left, seen), ...this.choices(value.right, seen)];
    const bound = this.constInitializer(value);
    return bound === undefined ? [value] : this.choices(bound, seen);
  }

  private constInitializer(expr: ts.Expression): ts.Expression | undefined {
    const decl = ts.isIdentifier(expr) ? this.symbolOf(expr)?.valueDeclaration : undefined;
    if (decl === undefined || !ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent)) return undefined;
    return (decl.parent.flags & ts.NodeFlags.Const) !== 0 ? decl.initializer : undefined;
  }

  private outside(decl: ts.Node): ResolvedCall {
    return this.program.isSourceFileDefaultLibrary(decl.getSourceFile()) ? NONE : EXTERNAL;
  }

  /** `new X()` of a class without a constructor of its own runs nothing the pass looks at. */
  private implicitConstructor(call: ts.NewExpression): ResolvedCall {
    const decl = this.symbolOf(call.expression)?.valueDeclaration;
    if (decl === undefined) return OPAQUE;
    return this.own.has(decl.getSourceFile()) ? NONE : this.outside(decl);
  }

  /** `decl` when it has a body, then what overrides or implements it in the package's classes. */
  private bodies(decl: ts.SignatureDeclaration, via: EdgeVia): CallTarget[] {
    const out: CallTarget[] = isFunctionLike(decl) && decl.body !== undefined ? [{ fn: decl, via }] : [];
    return addTargets(out, this.standInTargets(decl, via, false));
  }

  private standInTargets(decl: ts.Declaration, via: EdgeVia, gettersOnly: boolean): CallTarget[] {
    const standInVia = via === 'direct' ? 'implementation' : via;
    return this.standIns(decl)
      .filter((fn) => !gettersOnly || ts.isGetAccessorDeclaration(fn))
      .map((fn) => ({ fn, via: standInVia }));
  }

  /** The bodies the package's classes give a member of a class or interface: overrides and implementations. */
  private standIns(decl: ts.Declaration): FunctionLike[] {
    const owner = decl.parent;
    const name = memberName(decl);
    if (name === undefined || !(ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) || owner.name === undefined) return [];
    const symbol = this.checker.getSymbolAtLocation(owner.name);
    const isStatic = hasModifier(decl, ts.ModifierFlags.Static);
    const classes = symbol === undefined ? [] : (this.implementations.get(symbol) ?? []);
    return classes.map((cls) => this.member(cls, name, isStatic)).filter((fn): fn is FunctionLike => fn !== undefined);
  }

  /** The member `name` of `cls` (of its instances, or of the class itself when static), its own or the nearest base class's, when the package declares its body. */
  private member(cls: ts.ClassDeclaration, name: string, isStatic: boolean): FunctionLike | undefined {
    const side = isStatic ? this.staticType(cls) : this.instanceType(cls);
    const decl = side?.getProperty(name)?.declarations?.find((d): d is FunctionLike => isFunctionLike(d) && d.body !== undefined);
    return decl !== undefined && this.own.has(decl.getSourceFile()) ? decl : undefined;
  }

  private classSymbol(cls: ts.ClassDeclaration): ts.Symbol | undefined {
    return cls.name === undefined ? undefined : this.checker.getSymbolAtLocation(cls.name);
  }

  private instanceType(cls: ts.ClassDeclaration): ts.Type | undefined {
    const symbol = this.classSymbol(cls);
    return symbol === undefined ? undefined : this.checker.getDeclaredTypeOfSymbol(symbol);
  }

  private staticType(cls: ts.ClassDeclaration): ts.Type | undefined {
    const symbol = this.classSymbol(cls);
    return symbol === undefined ? undefined : this.checker.getTypeOfSymbolAtLocation(symbol, cls);
  }

  /** An import names an alias; the class, interface or token behind it is what other files see. */
  private symbolOf(node: ts.Node): ts.Symbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  /** Every base class and interface of `cls`, at any depth, and its `@Injectable(Token)` token map to it. */
  private index(cls: ts.ClassDeclaration): void {
    const seen = new Set<ts.Symbol>();
    const add = (symbol: ts.Symbol | undefined): void => {
      if (symbol === undefined || seen.has(symbol)) return;
      seen.add(symbol);
      this.implementations.set(symbol, [...(this.implementations.get(symbol) ?? []), cls]);
      for (const base of this.checker.getDeclaredTypeOfSymbol(symbol).getBaseTypes() ?? []) add(base.getSymbol());
      // `getBaseTypes` of a class gives its base class only, not the interfaces that base class implements.
      for (const type of (symbol.declarations ?? []).flatMap(implementedBy)) add(this.symbolOf(type.expression));
    };
    for (const base of this.instanceType(cls)?.getBaseTypes() ?? []) add(base.getSymbol());
    for (const clause of cls.heritageClauses ?? []) for (const type of clause.types) add(this.symbolOf(type.expression));
    const token = findDecorator(cls, 'Injectable')?.args[0];
    if (token !== undefined) add(this.symbolOf(token));
  }

  /** How the receiver of `callee` (`receiver.member`) was obtained. */
  private viaOf(callee: ts.Expression): EdgeVia {
    if (!ts.isPropertyAccessExpression(callee)) return 'direct';
    const receiver = callee.expression;
    if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression) && receiver.expression.name.text === 'resolve' && receiver.expression.expression.getText() === 'DI') return 'resolve';
    if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const property = this.checker.getSymbolAtLocation(receiver.name)?.valueDeclaration;
      if (property !== undefined && ts.isPropertyDeclaration(property) && findDecorator(property, ...INJECT_DECORATORS) !== undefined) return 'injected';
    }
    return 'direct';
  }
}
