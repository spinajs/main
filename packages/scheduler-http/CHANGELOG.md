# Changelog

## Unreleased

### Added

- First release of `@spinajs/scheduler-http`: endpoints for schedules, runs, error groups and prune
  (design `docs/plans/2026-10-15-scheduler-design.md` §7), guarded by `rbac-http` on the `scheduler`
  resource with `readAny` / `updateAny` / `deleteAny` tiers.
- Server-Sent Events streams `GET /scheduler/runs/:id/events` and `GET /scheduler/schedules/:name/events`
  with `Last-Event-ID` resume, `: ping` heartbeat (`scheduler.http.sse.heartbeat`, default 15 s) and
  close after the terminal status.
- `@spinajs/http`: `SseResponse` / `SseStream`; open streams close on `http.server.closing`.
  `@spinajs/http-swagger`: `SseResponse` is documented as `text/event-stream`.
