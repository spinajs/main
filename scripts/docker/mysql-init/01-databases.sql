-- The mysql image's MYSQL_DATABASE only creates a single schema, but the orm-mysql suite
-- connects to two (`test` and `test-2`, see packages/orm-mysql/test/mysql.test.ts).
CREATE DATABASE IF NOT EXISTS `test` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS `test-2` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The integration suite runs with a deliberately tiny client-side pool so that a leaked
-- connection deadlocks instead of passing quietly; make sure the server is not the limit.
GRANT ALL PRIVILEGES ON `test`.* TO 'root'@'%';
GRANT ALL PRIVILEGES ON `test-2`.* TO 'root'@'%';
FLUSH PRIVILEGES;
