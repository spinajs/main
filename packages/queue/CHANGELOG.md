# Changelog

## Unreleased

### Fixed
- `QueueService.dispose()` waits for every connection to close instead of returning immediately.

### Changed
- The ActiveMQ test fixture moved to the root `docker-compose.yml` ( service `activemq`, profile `test` ). The
  old `rmohr/activemq` ( ActiveMQ 5.15 ) Dockerfile is gone.
- `test/jobs.test.ts` ( live broker ) logs in with the fixture credentials ( `QUEUE_IT_STOMP_*` ) and skips itself
  when no broker answers, so `npm test` no longer needs a broker.
