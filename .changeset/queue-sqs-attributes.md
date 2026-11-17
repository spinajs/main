---
'@spinajs/queue-sqs-transport': major
---

Breaking for subclasses of `SqsQueueClient`: the second parameter of `handleMessage(desc, m)` is `SqsReceived` (`Body`, `ReceiptHandle`, `MessageId`, `MessageAttributes`, `Attributes`) where it was `{ Body?, ReceiptHandle? }`.

Sends carry `MessageAttributes` (standard headers first, at most 10, no empty values). A send to a `.fifo` URL gets `MessageGroupId` from the message field the routing `groupBy` names and `MessageDeduplicationId` from the MessageId; without `groupBy`, or with an empty field, `emit()` throws `InvalidArgument` before anything is sent. Subscribing to a FIFO queue needs no `groupBy`. `ScheduleDelay` becomes `DelaySeconds` on standard queues, and delays above 900 s are carried by `x-spinajs-not-before` and re-sent on receipt; a FIFO queue takes no per-message delay, so there the delay is dropped with a warning. Received messages get `MessageId` and standard `Headers` from the attributes. Protected API: `sendParams`, `groupIdOf`, `sendMessage`, `deleteMessage`, `isFifo` and `now` are new; `handleMessage` takes `SqsReceived`; `ISqsSubscriptionDescriptor` is exported. The unit tests now run in CI.

Nothing is sent that SQS refuses at runtime: attributes with a refused name or character, or past an 8 KiB budget, are left out (the body keeps every header); a group id over 128 characters or outside printable ASCII makes `emit()` throw `InvalidArgument`; a MessageId SQS would refuse as a deduplication id is replaced by its SHA-256; `DelaySeconds` is a whole number from 1 to 900, and a `ScheduleDelay` that is not a positive number is no delay.
