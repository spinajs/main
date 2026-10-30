## Manifest diff

Result: **BREAKING** (5 breaking of 6 changes)

`f011e0060289` -> `ffffffffffff`

### routes

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /users/:id` | yes | response.name property removed |
| changed | `GET /users/list` | yes | parameter query (FromQuery) removed; response[].name property removed |
| changed | `POST /users/create` | yes | response\|UserDto.name property removed |

### permissions

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /health/get` | yes | health:read now required on GET /health/get |

### schemas

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `spinajs/app-basic/UserDto` | no | schema changed |

### config

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| removed | `app` | yes |  |
