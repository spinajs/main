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

export const isFunctionLike = (d: ts.Node | undefined): d is FunctionLike =>
  d !== undefined && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isFunctionExpression(d) || ts.isArrowFunction(d) || ts.isGetAccessorDeclaration(d) || ts.isConstructorDeclaration(d));
const isAbstract = (d: ts.Declaration): boolean => (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Abstract) !== 0;

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
    if (this.checker.getTypeAtLocation(expr).getCallSignatures().length === 0) return NONE;
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
    const decl = this.checker.getSymbolAtLocation(access.name)?.declarations?.find(ts.isGetAccessorDeclaration);
    return decl === undefined ? [] : this.bodies(decl, this.viaOf(access));
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
    const decl = this.checker.getResolvedSignature(call)?.getDeclaration();
    if (decl === undefined) return ts.isNewExpression(call) ? this.implicitConstructor(call) : OPAQUE;
    if (!this.own.has(decl.getSourceFile())) return this.outside(decl);
    // A function type: a callback parameter, a member or a variable typed as a function.
    if (!isFunctionLike(decl) && !ts.isMethodSignature(decl)) return OPAQUE;
    const targets = this.bodies(decl, ts.isNewExpression(call) ? 'direct' : this.viaOf(call.expression));
    return { targets, opaque: targets.length === 0, external: false };
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
    const out: CallTarget[] = [];
    if (isFunctionLike(decl) && decl.body !== undefined) out.push({ fn: decl, via });
    for (const fn of this.standIns(decl)) {
      if (!out.some((t) => t.fn === fn)) out.push({ fn, via: via === 'direct' ? 'implementation' : via });
    }
    return out;
  }

  /** The bodies the package's classes give a member of a class or interface: overrides and implementations. */
  private standIns(decl: ts.SignatureDeclaration): FunctionLike[] {
    const owner = decl.parent;
    const name = ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isGetAccessorDeclaration(decl) ? decl.name : undefined;
    if (name === undefined || ts.isComputedPropertyName(name) || !(ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) || owner.name === undefined) return [];
    const symbol = this.checker.getSymbolAtLocation(owner.name);
    const classes = symbol === undefined ? [] : (this.implementations.get(symbol) ?? []);
    return classes.map((cls) => this.member(cls, name.getText())).filter((fn): fn is FunctionLike => fn !== undefined);
  }

  /** The member `name` an instance of `cls` has, its own or the nearest base class's, when the package declares its body. */
  private member(cls: ts.ClassDeclaration, name: string): FunctionLike | undefined {
    const decl = this.instanceType(cls)
      ?.getProperty(name)
      ?.declarations?.find((d): d is FunctionLike => isFunctionLike(d) && d.body !== undefined);
    return decl !== undefined && this.own.has(decl.getSourceFile()) ? decl : undefined;
  }

  private instanceType(cls: ts.ClassDeclaration): ts.Type | undefined {
    const symbol = cls.name === undefined ? undefined : this.checker.getSymbolAtLocation(cls.name);
    return symbol === undefined ? undefined : this.checker.getDeclaredTypeOfSymbol(symbol);
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
