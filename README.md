# SpinaJS

Monorepo of the SpinaJS framework packages. Each package lives under `packages/` and is
published independently to npm under the `@spinajs/` scope.

```bash
npm install      # install once, at the repo root (npm workspaces)
npm run build    # build every package
npm test         # run every package's unit suite
```

To work on a single package, run its scripts from its own directory:

```bash
cd packages/orm && npm test
```

> Packages resolve each other through the workspace symlinks into their **built** `lib/`
> output. After changing `packages/orm/src`, rebuild it (`npm run build` in that package)
> before running a dependent package's suite, or the dependent will keep testing the old code.

## Running integration tests

The unit suites (`npm test`) never touch a real database — they run everywhere, including CI
without Docker. Tests that need a live server live under `test/integration/` and run from a
separate script, so they are opt-in.

### SQLite

No services needed; the suite creates a temporary on-disk database and removes it afterwards.

```bash
cd packages/orm-sqlite && npm run test:integration
```

### MySQL

Start the container first. Every compose service sits behind the `test` profile, so a bare
`docker compose up` starts nothing:

```bash
docker compose --profile test up -d mysql

# wait for the healthcheck to go green
docker compose ps

cd packages/orm-mysql && npm run test:integration
```

Tear down with `docker compose --profile test down` (add `-v` to drop the data volume too).

The container publishes MySQL on host port **3900**, deliberately not 3306, so it cannot
collide with a MySQL already installed on the machine. It creates the `test` and `test-2`
schemas the suites expect.

#### Environment

The MySQL integration suite reads these, falling back to the compose defaults:

| Variable | Default |
| --- | --- |
| `ORM_TEST_MYSQL_HOST` | `127.0.0.1` |
| `ORM_TEST_MYSQL_PORT` | `3900` |
| `ORM_TEST_MYSQL_USER` | `root` |
| `ORM_TEST_MYSQL_PASSWORD` | `root` |
| `ORM_TEST_MYSQL_DATABASE` | `test` |

The suite deliberately configures a `PoolLimit` of 2. That is what makes the
connection-release test meaningful: if a transaction ever failed to return its pooled
connection, the loop would exhaust the pool and hang rather than passing quietly.
