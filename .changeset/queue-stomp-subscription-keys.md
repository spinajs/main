---
'@spinajs/queue-stomp-transport': minor
---

Subscriptions are keyed by channel and, on a topic, by `subscriptionId`: two subscription ids on one topic are two broker subscriptions, where the second was ignored before. The STOMP subscription id is `<subscriptionId>@<channel>`, so one `subscriptionId` used on two channels of a connection no longer overwrites the first subscription's callback. `unsubscribe(channel)` removes every subscription of the channel. Durable subscriptions keep their identity (`client-id` and `activemq.subscriptionName`). `dispose()` forgets every tracked subscription.

Upgrading: a message class consumed durably on a topic under a different `subscriptionId` than another class on that topic used to join the first class's durable subscription. It now gets its own durable subscription, created at its first subscribe. Its messages still stored in the shared subscription are delivered there, skipped by `QueueService` (the `Name` does not match) and acked without running its handler. Drain the topic before deploying (stop publishing and let the consumers empty the shared subscription), or accept the loss; to keep the shared subscription, give both classes the first class's `subscriptionId`.
