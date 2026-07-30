import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { IMigrationDescriptor, MIGRATION_DESCRIPTION_SYMBOL, Migration, OrmDriver, OrmMigration } from '../src/index.js';

const expect = chai.expect;

const descriptorOf = (type: unknown): IMigrationDescriptor | undefined => (type as Record<symbol, IMigrationDescriptor>)[MIGRATION_DESCRIPTION_SYMBOL];

/** Prefixed like every other migration fixture in this package - see the note in migration-runner.test.ts. */
@Migration('some-connection')
class MigrationDecoratorTest_Plain_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

@Migration('some-connection', { Env: 'local' })
class MigrationDecoratorTest_Tagged_2026_07_29_10_01_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

@Migration('parent-connection', { Env: 'parent-env' })
class MigrationDecoratorTest_SubclassParent_2026_07_29_10_30_00 extends OrmMigration {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

@Migration('child-connection', { Env: 'child-env' })
class MigrationDecoratorTest_SubclassChild_2026_07_29_10_30_01 extends MigrationDecoratorTest_SubclassParent_2026_07_29_10_30_00 {
  public async up(_c: OrmDriver): Promise<void> {}
  public async down(_c: OrmDriver): Promise<void> {}
}

describe('@Migration', () => {
  after(() => {
    DI.unregister(MigrationDecoratorTest_Plain_2026_07_29_10_00_00);
    DI.unregister(MigrationDecoratorTest_Tagged_2026_07_29_10_01_00);
    DI.unregister(MigrationDecoratorTest_SubclassParent_2026_07_29_10_30_00);
    DI.unregister(MigrationDecoratorTest_SubclassChild_2026_07_29_10_30_01);
  });

  it('keeps the single-argument form working', () => {
    const d = descriptorOf(MigrationDecoratorTest_Plain_2026_07_29_10_00_00);

    expect(d?.Connection).to.equal('some-connection');
    expect(d?.Env, 'an untagged migration must not carry an env').to.equal(undefined);
  });

  it('records the Env option', () => {
    expect(descriptorOf(MigrationDecoratorTest_Tagged_2026_07_29_10_01_00)?.Env).to.equal('local');
  });

  it('captures the file the decorator was applied in', () => {
    const file = descriptorOf(MigrationDecoratorTest_Plain_2026_07_29_10_00_00)?.SourceFile;

    expect(file, 'no source file was captured').to.be.a('string');
    expect(file!.replace(/\\/g, '/')).to.contain('test/migration-decorator.test.ts');
  });

  it('still registers the class under __migrations__', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(MigrationDecoratorTest_Plain_2026_07_29_10_00_00);
  });

  it('gives each subclass its own descriptor instead of mutating the parent', () => {
    const parentDesc = descriptorOf(MigrationDecoratorTest_SubclassParent_2026_07_29_10_30_00);
    const childDesc = descriptorOf(MigrationDecoratorTest_SubclassChild_2026_07_29_10_30_01);

    // They must have distinct descriptor objects, not share the same one through the prototype chain
    expect(parentDesc).to.not.equal(childDesc);

    // Parent should retain its own values
    expect(parentDesc?.Connection).to.equal('parent-connection');
    expect(parentDesc?.Env).to.equal('parent-env');

    // Child should have its own values, not the parent's
    expect(childDesc?.Connection).to.equal('child-connection');
    expect(childDesc?.Env).to.equal('child-env');
  });
});
