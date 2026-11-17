---
"@spinajs/http-socket": minor
---

New port `SocketConnectionContext`: a registered implementation is asked once per handshake, after the principal is known, and the keys it returns are part of the store of every command, event and hook of that connection (`SocketConnection.context`). A throw refuses the handshake. The fixed keys of the call store cannot be replaced. Without a registered implementation nothing changes.
