---
'@spinajs/queue-stomp-transport': minor
---

Subscriptions are keyed by channel and, on a topic, by `subscriptionId`: two subscription ids on one topic are two broker subscriptions, where the second was ignored before. The STOMP subscription id is `<subscriptionId>@<channel>`, so one `subscriptionId` used on two channels of a connection no longer overwrites the first subscription's callback. `unsubscribe(channel)` removes every subscription of the channel. Durable subscriptions keep their identity (`client-id` and `activemq.subscriptionName`). `dispose()` forgets every tracked subscription.
