# Release notes — electron IPC on authz-v3 (C9)

> Merged into the root `RELEASE_NOTES.md` for 3.0.0-rc.1.

- `__spinajsIpcBridge:call` and `__spinajsIpcBridge:callOnOrmConnection` run in the main process under `authz().runAs(SYSTEM, 'electron-ipc')` (design §14.1). With `authz.audit.runAs` on, each call writes one audit entry. Calls to the `Log` service run as they are, so renderer log lines write no audit entries.
- `__spinajsIpcBridge:callSync` answers synchronously and cannot run as SYSTEM: it runs unattended, so a scoped ORM query or an authz check inside it is denied.
- An app that never boots authz runs IPC calls as before.
- A sync call to a service that is not registered now returns the error instead of throwing a `TypeError`.
