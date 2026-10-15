import '@spinajs/orm-mysql';
import { mutexContract } from './contract.js';

mutexContract('OrmMutex on MySQL', {
  Name: 'mysql',
  Driver: 'orm-driver-mysql',
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
  Database: process.env.ORM_TEST_MYSQL_DATABASE ?? 'test',
});
