---
"@spinajs/log-source-graphana-loki": patch
---

Security: the Loki target no longer writes a credential into the application's other log targets. Before, every successful push logged `options.host` as configured at `trace`, so userinfo in it (`https://user:secret@loki…`, a Grafana Cloud `https://<id>:<api key>@logs-…` URL) reached every target that `LogLokiTarget` routes to; a failed push logged, and kept in `Error`, the raw axios error, whose `config` and `request` carry the host and the Basic `Authorization` header built from `auth`. The host is now logged without userinfo and query, with a path segment that may be a token as `***`, and as `<not a URL>` when it does not parse; a failure is logged and kept as an `Error` with the failure's name, code, HTTP status and its message with the host redacted. If a credential was ever in `host`, treat it as exposed in your logs and rotate it; put credentials in `auth`.
