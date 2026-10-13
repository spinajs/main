import { AuthzConfigError, GLOBAL, SCOPE_CONDITION_OP, parseScopeConditionArgs } from '@spinajs/authz';
import type { Principal, ScopeConditionArgs } from '@spinajs/authz';
import { OrmNativeCompiler } from '@spinajs/authz-orm';
import { Container, Inject, Injectable } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { IdentifierQuoter } from '@spinajs/orm';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { rbacDialectOf } from './compile/dialect.js';
import { RbacPathSql } from './compile/path.js';
import { RBAC_SQLITE_TERM_DEPTH } from './compile/rules.js';
import { scopeConditionSql } from './compile/scope-leaf.js';
import { sqliteParserDepth } from './compile/sqlite-depth.js';
import { whereRbacSql } from './compile/sql.js';
import { RbacListCompiler } from './rbac-orm-compiler.js';

/**
 * `native:condition.scope` (RFC K1b-1, `@spinajs/authz` conditions/scope-leaf.ts) → `scopeConditionSql`: the
 * residual leaves ABAC's `scopeResiduals` makes of `scope.<type>.*` comparisons on a list. Path, dialect and the
 * attribute layers and defaults (`RbacScopeAttributeSource`) as for the rule terms; Postgres needs JIT off as they do.
 */
@Injectable(OrmNativeCompiler)
@Inject(Container)
export class ConditionScopeOrmCompiler extends RbacListCompiler {
  readonly op = SCOPE_CONDITION_OP;

  constructor(container: IContainer) {
    super(container);
  }

  /** The args name no principal, and `_principal` is not read (RFC E2-2). */
  compile(args: unknown, builder: IWhereBuilder<unknown>, model: Class<ModelBase>, _principal: Principal): void {
    const pathOf = this.pathOf(model);
    const parsed = this.parseArgs(args, pathOf.type);
    const driver = this.driverOf(builder);
    const dialect = rbacDialectOf(driver);
    const term = scopeConditionSql(parsed, { path: new RbacPathSql(pathOf, driver.Container.resolve(IdentifierQuoter), dialect), rowType: pathOf.type, defaults: this.scopeDefaults(model, driver), dialect });
    if (dialect.name === 'sqlite') {
      const depth = sqliteParserDepth(term);
      if (depth > RBAC_SQLITE_TERM_DEPTH) throw new AuthzConfigError(`${this.where(pathOf.type)}: scope.${parsed.type}.${parsed.path} needs about ${depth} entries of SQLite's parser stack, more than the ${RBAC_SQLITE_TERM_DEPTH} a term may take`);
    }
    whereRbacSql(builder, term);
  }

  /** `parseScopeConditionArgs`, and a type a scope reference can name on a list: no '.', not GLOBAL. */
  protected parseArgs(args: unknown, rowType: string): ScopeConditionArgs {
    const parsed = parseScopeConditionArgs(args);
    if (!parsed) throw new AuthzConfigError(`${this.where(rowType)}: malformed args ${describe(args)}`);
    if (parsed.type.includes('.') || parsed.type === GLOBAL.type) throw new AuthzConfigError(`${this.where(rowType)}: no scope leaf reads type ${JSON.stringify(parsed.type)} (a type with '.' or ${GLOBAL.type})`);
    return parsed;
  }
}

function describe(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return typeof args;
  }
}
