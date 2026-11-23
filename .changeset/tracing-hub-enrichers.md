---
"@spinajs/tracing": minor
---

`SpanProcessorHub.add(processor, { enricher: true })` attaches a processor that only decorates spans other processors record, such as one that sets an attribute in `onStart`. The hub starts every span in its enrichers first, and `HubSampler` keeps recording nothing while only enrichers are attached (`hub.recording` is false), so an enricher alone leaves an app in id-only mode. `hub.size` still counts every attached processor.
