# SpinaJS documentation

One folder per package under `docs/`. Each package page lists its features and links to the detail pages.

## Start here

| Page | What it covers |
| --- | --- |
| [What is new in 4.x](whats-new-4.0.md) | The manifest build, doctor, validation from types, generators, the typed client, testing; the path from `npm run build` to a deployed app; `off`, `prefer` or `require` |
| [Upgrading to 4.0](upgrading/4.0.md) | Breaking changes (ESM, Node 22, `lib/` paths, problem+json, config arrays) and the codemod |

## Build, manifest and tooling

| Package | What it covers |
| --- | --- |
| [`@spinajs/cli`](cli/README.md) | The `spinajs` bin, commands, `build`, generators; [every command and option](cli/08-command-reference.md) |
| [`@spinajs/compiler`](compiler/README.md) | The analyzer that writes the manifest; [spinajs doctor](compiler/doctor.md) |
| [`@spinajs/manifest`](manifest/README.md) | Manifest types and runtime, modes, bundles; [manifest diff and CI](manifest/diff-and-ci.md); [deploying](manifest/deploying.md) |
| [`@spinajs/client`](client/README.md) | Generated typed HTTP client |
| [`@spinajs/openapi`](openapi/README.md) | OpenAPI 3.1 from the manifest |
| [`@spinajs/asyncapi`](asyncapi/README.md) | AsyncAPI 3.0 from the manifest |
| [`@spinajs/testing`](testing/README.md) | `createTestApp`, `useTestApp`, contract tests |

## Core

| Package | What it covers |
| --- | --- |
| [`@spinajs/di`](di/README.md) | Dependency injection container |
| [`@spinajs/configuration`](configuration/README.md) | Config files, sources, typed paths |
| [`@spinajs/configuration-common`](configuration-common/README.md) | Shared configuration contracts and templating |
| [`@spinajs/validation`](validation/README.md) | Ajv validation, `@Schema`, [DTO constraints with JSDoc tags](validation/09-dto-constraints-jsdoc.md) |
| [`@spinajs/exceptions`](exceptions/README.md) | Shared exception classes |
| [`@spinajs/reflection`](reflection/README.md) | Loading classes from directories |
| [`@spinajs/hooks`](hooks/README.md) | Action hooks |
| [`@spinajs/util`](util/README.md) | Shared utilities |
| [`@spinajs/threading`](threading/README.md) | Mutex, critical section, rate limit |
| [`@spinajs/idempotency`](idempotency/README.md) | Run a call once per key, replay its reply, take over a dead replica's claim |
| [`@spinajs/intl`](intl/README.md) | Translations |
| [`@spinajs/internal-logger`](internal-logger/README.md) | Logger for code that runs before the real one |

## HTTP and sockets

| Package | What it covers |
| --- | --- |
| [`@spinajs/http`](http/README.md) | HTTP server, controllers, [route arguments](http/04-route-arguments.md), [error handling](http/11-error-handling.md) |
| [`@spinajs/http-swagger`](http-swagger/README.md) | Runtime OpenAPI document and Swagger UI |
| [`@spinajs/http-bot`](http-bot/README.md) | Bot verification |
| [`@spinajs/http-lazy-file-uploader`](http-lazy-file-uploader/README.md) | Deferred file copy |
| [`@spinajs/upload`](upload/README.md) | Resumable chunked uploads |
| [`@spinajs/http-socket`](http-socket/README.md) | WebSocket server |
| [`@spinajs/http-socket-common`](http-socket-common/README.md) | Wire protocol and [typed contracts](http-socket-common/06-typed-contracts.md) |
| [`@spinajs/http-socket-client`](http-socket-client/README.md) | Socket client |
| [`@spinajs/http-socket-example`](http-socket-example/README.md) | A runnable notes server and client, with a bundle recipe |
| [`@spinajs/intl-http`](intl-http/README.md) | Per-request language |

## Data and storage

| Package | What it covers |
| --- | --- |
| [`@spinajs/orm`](orm/README.md) | ORM core |
| [`orm-sql`](orm-sql/README.md), [`orm-sqlite`](orm-sqlite/README.md), [`orm-mysql`](orm-mysql/README.md), [`orm-postgres`](orm-postgres/README.md), [`orm-mssql`](orm-mssql/README.md) | SQL layer and drivers |
| [`@spinajs/orm-cli`](orm-cli/README.md) | Migration commands |
| [`@spinajs/orm-http`](orm-http/README.md) | Route arguments that load models |
| [`@spinajs/orm-threading`](orm-threading/README.md) | Database-backed mutex |
| [`@spinajs/intl-orm`](intl-orm/README.md) | Per-language column values |
| [`configuration-db-source`](configuration-db-source/README.md), [`configuration-http`](configuration-http/README.md) | Database-stored configuration and its HTTP API |
| [`@spinajs/fs`](fs/README.md), [`fs-s3`](fs-s3/README.md), [`fs-ftp`](fs-ftp/README.md), [`fs-onedrive`](fs-onedrive/README.md) | File system abstraction and providers |
| [`configuration-fs-protocol`](configuration-fs-protocol/README.md), [`configuration-aws-secretmanager-protocol`](configuration-aws-secretmanager-protocol/README.md) | Configuration value protocols |

## Authentication and authorization

| Package | What it covers |
| --- | --- |
| [`@spinajs/authn`](authn/README.md) | Authentication core |
| [`authn-http`](authn-http/README.md), [`authn-session`](authn-session/README.md), [`authn-token`](authn-token/README.md), [`authn-local`](authn-local/README.md), [`authn-keys`](authn-keys/README.md), [`authn-oidc`](authn-oidc/README.md), [`authn-totp`](authn-totp/README.md), [`authn-webauthn`](authn-webauthn/README.md), [`authn-orm`](authn-orm/README.md), [`authn-testing`](authn-testing/README.md) | Strategies, sessions, stores and the test kit |
| [`session-provider-db`](session-provider-db/README.md), [`session-provider-redis`](session-provider-redis/README.md), [`session-provider-dynamodb`](session-provider-dynamodb/README.md) | Session stores |
| [`@spinajs/authz`](authz/README.md) | Authorization core |
| [`authz-rbac`](authz-rbac/README.md), [`authz-abac`](authz-abac/README.md), [`authz-rebac`](authz-rebac/README.md) | Access models |
| [`authz-http`](authz-http/README.md), [`authz-http-admin`](authz-http-admin/README.md), [`authz-orm`](authz-orm/README.md), [`authz-fs`](authz-fs/README.md), [`authz-queue`](authz-queue/README.md), [`authz-testing`](authz-testing/README.md), [`authz-convert`](authz-convert/README.md), [`eslint-plugin-authz`](eslint-plugin-authz/README.md) | Integrations, tooling and the 2.x converter |
| [`users`](users/README.md), [`users-http`](users-http/README.md), [`teams`](teams/README.md), [`teams-http`](teams-http/README.md) | User accounts, teams and groups |

## Messaging, email and templates

| Package | What it covers |
| --- | --- |
| [`@spinajs/queue`](queue/README.md) | Queue abstraction |
| [`queue-amqp-transport`](queue-amqp-transport/README.md), [`queue-sqs-transport`](queue-sqs-transport/README.md), [`queue-stomp-transport`](queue-stomp-transport/README.md) | Transports |
| [`queue-http-progress`](queue-http-progress/README.md), [`queue-templates-pdf`](queue-templates-pdf/README.md) | Job progress route, PDF job |
| [`@spinajs/email`](email/README.md), [`email-smtp-transport`](email-smtp-transport/README.md) | Sending mail |
| [`email-verification`](email-verification/README.md), [`email-verification-orm`](email-verification-orm/README.md), [`email-verification-redis`](email-verification-redis/README.md), [`email-verification-dynamodb`](email-verification-dynamodb/README.md) | Address checks and stores |
| [`@spinajs/templates`](templates/README.md) | Template service |
| [`templates-pug`](templates-pug/README.md), [`templates-handlebars`](templates-handlebars/README.md), [`templates-csv`](templates-csv/README.md), [`templates-xlsx`](templates-xlsx/README.md), [`templates-puppeteer`](templates-puppeteer/README.md), [`templates-pdf`](templates-pdf/README.md), [`templates-image`](templates-image/README.md), [`template-mjml`](template-mjml/README.md) | Renderers |

## Observability and platform

| Package | What it covers |
| --- | --- |
| [`@spinajs/log`](log/README.md), [`log-common`](log-common/README.md), [`log-otlp`](log-otlp/README.md), [`log-source-graphana-loki`](log-source-graphana-loki/README.md) | Logging and targets |
| [`@spinajs/telemetry`](telemetry/README.md), [`telemetry-common`](telemetry-common/README.md), [`telemetry-otel`](telemetry-otel/README.md) | Metrics and tracing |
| [`@spinajs/electron`](electron/README.md) | Services in the Electron main process |
