---
"@spinajs/orm": patch
---

A MySQL lock wait timeout (`ER_LOCK_WAIT_TIMEOUT`, 1205) is no longer treated as a lost connection. Outside a transaction the driver logged it as `connection ... lost`, replaced the connection pool (dropping the session settings of every pooled connection) and ran the statement again up to `Resilience.MaxRetries` times, ending `Disconnected`: with the server default `innodb_lock_wait_timeout` of 50 s and 5 retries a statement failed after about five minutes. It now fails after one wait with the lock wait error, the pool and the connection state stay. `RETRYABLE_ERROR_CODES` and `isRetryableErrorCode()` no longer list it; retry lock contention in your own code if you need to.
