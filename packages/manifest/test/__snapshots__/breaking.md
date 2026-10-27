## Manifest diff

Result: **BREAKING** (5 breaking of 6 changes)

`246587929cea` -> `ffffffffffff`

### routes

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /users` | yes | parameter query (FromQuery) removed; response[].name property removed |
| changed | `GET /users/:id` | yes | response.name property removed |
| changed | `POST /users` | yes | response\|0.name property removed |

### permissions

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /health` | yes | health:read now required on GET /health |

### schemas

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `spinajs/app-basic/UserDto` | no | schema changed |

### config

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| removed | `hooks` | yes |  |
