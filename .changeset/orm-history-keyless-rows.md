---
"@spinajs/orm-history": minor
---

History flags every statement that reaches or writes a row whose primary key has no text (bytes, a date, a number that is not a safe integer), from the `keylessRows` count of the write capture: an update, a delete and an upsert now record the `lost` event with `reason: 'keys_without_text'` and warn once per model, as a plain insert did, or fail with `HistoryWriteError` under `audit.data.onUnknownKeys: 'throw'`. The error and the warning name the statement (`orm-history: an update of <entity> reached a primary key <pk> that has no text ...`); the insert's message says "reached" where it said "wrote".
