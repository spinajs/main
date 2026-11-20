---
"@spinajs/workflow-http": minor
---

New package: the HTTP API of `@spinajs/workflow` at `workflow/instances`. `GET /` lists instances (filters `workflow`, `status`, `limit`, `after`) and `GET :id` shows one with its journal rows; both need `workflow:read` and leave out the input, the result and the stack and details of errors. `GET :id/payload` returns them and needs `workflow:read-payload`. The package config declares the permissions `workflow:read`, `workflow:read-payload`, `workflow:signal` and `workflow:manage` and an `admin.workflow` role for `@spinajs/authz-rbac`.
