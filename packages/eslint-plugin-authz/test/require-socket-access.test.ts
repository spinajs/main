import { RuleTester } from '@typescript-eslint/rule-tester';

import { requireSocketAccess } from '../src/rules/require-socket-access.js';

// RuleTester finds mocha's describe/it as globals; only the teardown hook has another name.
RuleTester.afterAll = after;

const ruleTester = new RuleTester();

const imports = "import { BaseSocketController, Command, OnConnect, OnEvent, SocketAccess, SocketController, SocketPolicy, SocketPolicyGroup } from './socket';\n";
const code = (body: string) => `${imports}${body}\n`;
const unguarded = (controller: string, method: string, kind = 'command') => ({ messageId: 'unguardedHandler' as const, data: { controller, method, kind } });

ruleTester.run('require-socket-access', requireSocketAccess, {
  valid: [
    code("class S extends BaseSocketController { @Command('open') @SocketAccess('doc:read') public open() {} }"),
    code("class S extends BaseSocketController { @OnEvent('seen') @SocketPolicy(SignedIn) public seen() {} }"),
    code("@SocketPolicy(SignedIn) class S extends BaseSocketController { @Command('a') public a() {} @OnEvent('b') public b() {} }"),
    code("@SocketController('s') @SocketAccess('doc:read') class S extends BaseSocketController { @Command() public a() {} }"),
    code('class S extends BaseSocketController { @Command() @SocketPolicyGroup(group) public a() {} }'),
    code('class S extends BaseSocketController { @OnConnect() public hello() {} public helper() {} }'),
    { code: code('class S extends BaseSocketController { @Command() @SignedIn() public a() {} }'), options: [{ guardDecorators: ['SignedIn'] }] },
  ],
  invalid: [
    { code: code("@SocketController('s') class S extends BaseSocketController { @Command('open') public open() {} }"), errors: [unguarded('S', 'open')] },
    { code: code("class S extends BaseSocketController { @OnEvent('seen') public seen() {} }"), errors: [unguarded('S', 'seen', 'event')] },
    {
      code: code("class S extends BaseSocketController { @Command() @SocketAccess('doc:read') public a() {} @sockets.Command() public b() {} }"),
      errors: [unguarded('S', 'b')],
    },
  ],
});
