import type { OrmDriver } from '@spinajs/orm';

export type FixtureTable = 'cf_users' | 'cf_tags' | 'cf_posts' | 'cf_post_tags' | 'cf_docs' | 'cf_events';
export type FixtureSeed = Partial<Record<FixtureTable, ReadonlyArray<Record<string, unknown>>>>;

/** Parents first: seeds insert in this order and the reset drops in the reverse one. */
export const FIXTURE_TABLES: readonly FixtureTable[] = ['cf_users', 'cf_tags', 'cf_posts', 'cf_post_tags', 'cf_docs', 'cf_events'];

async function createFixture(driver: OrmDriver): Promise<void> {
  const schema = driver.schema();

  await schema.createTable('cf_users', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('Name', 64).notNull();
    t.string('Email', 128);
    t.int('Age');
    t.boolean('Active').notNull();
    t.decimal('Score', 10, 2);
    t.dateTime('CreatedAt');
  });

  await schema.createTable('cf_tags', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('Name', 32).notNull();
  });

  await schema.createTable('cf_posts', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.int('UserId').notNull();
    t.string('Title', 128).notNull();
    t.int('Views').notNull();
    t.dateTime('PublishedAt');
    t.foreignKey('UserId').references('cf_users', 'Id');
  });

  await schema.createTable('cf_post_tags', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.int('PostId').notNull();
    t.int('TagId').notNull();
    t.foreignKey('PostId').references('cf_posts', 'Id');
    t.foreignKey('TagId').references('cf_tags', 'Id');
  });

  await schema.createTable('cf_docs', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('Label', 64);
    t.json('Body');
  });

  await schema.createTable('cf_events', (t) => {
    t.int('Id').primaryKey().autoIncrement();
    t.string('Name', 64).notNull();
    t.dateTime('At').notNull();
    t.date('Day');
  });
}

/** Drops and creates every fixture table, so each case starts from empty tables whose keys count from 1. */
export async function resetFixture(driver: OrmDriver): Promise<void> {
  for (const table of [...FIXTURE_TABLES].reverse()) {
    await driver.schema().dropTable(table).ifExists();
  }

  await createFixture(driver);
}

/** One INSERT per row, in seed order, so generated keys are 1, 2, 3 … on every dialect. */
export async function seedFixture(driver: OrmDriver, seed: FixtureSeed): Promise<void> {
  for (const table of FIXTURE_TABLES) {
    for (const row of seed[table] ?? []) {
      await driver.insert().into(table).values(row);
    }
  }
}
