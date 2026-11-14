import '@spinajs/orm-mysql';
import '@spinajs/orm-postgres';

const env = process.env;

/** Same variables as `scheduler/test/integration/real-db.ts`; a target whose host is unset is skipped. */
export const REAL_DB_TARGETS = [
  {
    name: 'postgres',
    enabled: !!env.SPINAJS_TEST_PG_HOST,
    connection: {
      Driver: 'orm-driver-postgres',
      Host: env.SPINAJS_TEST_PG_HOST,
      Port: Number(env.SPINAJS_TEST_PG_PORT ?? 5432),
      User: env.SPINAJS_TEST_PG_USER ?? 'postgres',
      Password: env.SPINAJS_TEST_PG_PASSWORD ?? 'postgres',
      Database: env.SPINAJS_TEST_PG_DB ?? 'spinajs_scheduler_test',
    },
  },
  {
    name: 'mysql',
    enabled: !!env.SPINAJS_TEST_MYSQL_HOST,
    connection: {
      Driver: 'orm-driver-mysql',
      Host: env.SPINAJS_TEST_MYSQL_HOST,
      Port: Number(env.SPINAJS_TEST_MYSQL_PORT ?? 3306),
      User: env.SPINAJS_TEST_MYSQL_USER ?? 'root',
      Password: env.SPINAJS_TEST_MYSQL_PASSWORD ?? '',
      Database: env.SPINAJS_TEST_MYSQL_DB ?? 'spinajs_scheduler_test',
    },
  },
];
