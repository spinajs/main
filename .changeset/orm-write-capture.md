---
"@spinajs/orm": minor
---

`WriteObserver` and `WriteCaptureMiddleware` (order 91): one before and one after read per write for every observer that asks for the statement, inside one transaction; `writeTargetKeys`, `upsertKeys`, `insertedKeys`, `captureKeyText`, `CaptureReadScope`; `db.WriteCapture.MaxRows` (default 0, unlimited). Without a registered observer nothing changes.
