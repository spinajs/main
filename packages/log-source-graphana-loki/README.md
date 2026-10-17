# `@spinajs/log-source-graphana-loki`

Grafana Loki log target for `@spinajs/log`: batches entries and pushes them to `/loki/api/v1/push` with retry, a bounded buffer and a drop hook. Import the package and use `type: "GraphanaLogTarget"` in `logger.targets`.

## Documentation

- [Package overview](../../docs/log-source-graphana-loki/README.md)
- [Loki target](../../docs/log-source-graphana-loki/01-loki-target.md)
- [Delivery, retry and buffering](../../docs/log-source-graphana-loki/02-delivery-and-retry.md)
- [Extending the Loki target](../../docs/log-source-graphana-loki/03-extending-the-loki-target.md)
