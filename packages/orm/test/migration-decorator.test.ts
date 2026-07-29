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

describe('@Migration', () => {
  after(() => {
    DI.unregister(MigrationDecoratorTest_Plain_2026_07_29_10_00_00);
    DI.unregister(MigrationDecoratorTest_Tagged_2026_07_29_10_01_00);
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
});
