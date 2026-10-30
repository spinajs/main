## Manifest diff

Result: non-breaking (4 changes)

`7a5a49a0abb5` -> `eeeeeeeeeeee`

### routes

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `GET /users/:id` | no | response.nick property added |
| changed | `GET /users/list` | no | response[].nick property added |
| changed | `POST /users/create` | no | response\|UserDto.nick property added |

### schemas

| Change | Id | Breaking | Detail |
| --- | --- | --- | --- |
| changed | `spinajs/app-basic/UserDto` | no | schema changed |
