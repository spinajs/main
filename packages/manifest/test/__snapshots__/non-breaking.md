## Manifest diff

Result: non-breaking (4 changes)

`246587929cea` -> `eeeeeeeeeeee`

### routes

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /users` | no | response[].nick property added |
| changed | `GET /users/:id` | no | response.nick property added |
| changed | `POST /users` | no | response\|0.nick property added |

### schemas

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `spinajs/app-basic/UserDto` | no | schema changed |
