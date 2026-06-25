# `@spinajs/configuration-aws-secretmanager-protocol`

Resolves [SpinaJS](https://github.com/spinajs) configuration values from **AWS Secrets Manager**
and **AWS Systems Manager Parameter Store** using custom configuration protocols.

Any string in your configuration that starts with a registered protocol is replaced, at load time,
with the value fetched from AWS.

## Usage

Import the package once (its side effects register the protocols with the DI container), then use the
protocols anywhere in your configuration:

```ts
import '@spinajs/configuration-aws-secretmanager-protocol';

export class AppConfig extends FrameworkConfiguration {
  public onLoad() {
    return {
      db: {
        // fetched from AWS Secrets Manager
        password: 'aws-secrets://prod/db/password',
        // a single key out of a JSON secret
        user: 'aws-secrets://prod/db/credentials#username',
      },
      service: {
        // fetched from AWS Parameter Store
        endpoint: 'aws-parameters://prod/service/endpoint',
      },

      // client options are passed straight to the AWS SDK clients (region, credentials, endpoint, ...)
      aws: {
        secretsManager: { region: 'eu-central-1' },
        parameterStore: { region: 'eu-central-1' },
      },
    };
  }
}
```

Credentials and region follow the standard AWS SDK resolution (shared config/credentials files,
`AWS_*` environment variables, instance/task roles, ...). Anything you put under
`aws.secretsManager` / `aws.parameterStore` is forwarded to the corresponding SDK client.

## Protocols

### `aws-secrets://` — AWS Secrets Manager

```
aws-secrets://<secretId>[?versionStage=..&versionId=..][?default=..|optional=true][#json.path]
```

| Part | Description |
| --- | --- |
| `<secretId>` | Secret name or full ARN. |
| `?versionStage=` | Secret version stage (defaults to `AWSCURRENT`). |
| `?versionId=` | Explicit secret version id (takes precedence over the default stage). |
| `#json.path` | Extract a single value from a JSON secret, dot notation for nesting (`#db.password`). |
| `?default=` / `?optional=true` | See [Resilience](#resilience). |

`SecretString` secrets are returned as a string. `SecretBinary` secrets are returned as a
base64-encoded string (or parsed as UTF-8 JSON when a `#json.path` is given).

### `aws-parameters://` — AWS Parameter Store

```
aws-parameters://<name>[?withDecryption=true|false][?default=..|optional=true][#json.path]
aws-parameters://<path>/*
```

| Part | Description |
| --- | --- |
| `<name>` | Parameter name. A version/label can be pinned with the native `:` syntax (`my/param:3`). |
| `?withDecryption=` | Decrypt `SecureString` parameters (defaults to `true`). |
| `#json.path` | Extract a single value from a JSON parameter (dot notation). |
| `/*` | Expand a whole hierarchy into a nested object (prefix stripped, recursive). |
| `?default=` / `?optional=true` | See [Resilience](#resilience). |

`StringList` parameters are returned as an array of strings.

Subtree expansion:

```ts
// given /prod/app/db/host, /prod/app/db/port, /prod/app/key in Parameter Store
{ app: 'aws-parameters://prod/app/*' }
// resolves to:
{ app: { db: { host: '...', port: '...' }, key: '...' } }
```

## Resilience

By default, if a value cannot be resolved the error is logged and the raw protocol string is left in
the configuration. Two opt-in query parameters change that:

- `?default=<value>` — use `<value>` when the fetch fails (handy for local development without AWS).
- `?optional=true` — resolve to an empty string when the fetch fails.

```
aws-secrets://prod/db/password?default=localdev
aws-secrets://optional/feature-flag?optional=true
```

## Caching

Resolved values are cached in memory per protocol with a TTL (default 5 minutes), and concurrent
requests for the same value are de-duplicated into a single AWS call. Configure or disable the TTL
(in ms, `0` disables) per protocol:

```ts
aws: {
  secretsManager: { region: 'eu-central-1', cacheTtl: 60000 },
  parameterStore: { region: 'eu-central-1', cacheTtl: 0 },
}
```
