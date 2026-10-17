# `@spinajs/internal-logger`

Logger for framework packages that run before `@spinajs/log` is configured. It buffers messages until `Configuration` is resolved, then forwards them to the logger registered under `__log__`. It is not meant for application code.

## Documentation

- [Overview](../../docs/internal-logger/README.md)
- [Logging API](../../docs/internal-logger/01-logging-api.md)
- [Buffer flush and exit dump](../../docs/internal-logger/02-buffer-flush-and-exit-dump.md)
- [Logger proxy](../../docs/internal-logger/03-logger-proxy.md)
- [Log sink (`__log__`)](../../docs/internal-logger/04-log-sink.md)
