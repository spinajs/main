import { RuleTester } from '@typescript-eslint/rule-tester';

import { requireHandlerAccess } from '../src/rules/require-handler-access.js';

// RuleTester finds mocha's describe/it as globals; only the teardown hook has another name.
RuleTester.afterAll = after;

const ruleTester = new RuleTester();

const imports = "import { Job, QueueEvent, QueueJob, SystemTask } from './queue';\n";
const code = (body: string) => `${imports}${body}\n`;

ruleTester.run('require-handler-access', requireHandlerAccess, {
  valid: [
    code("@Job({ runAs: 'initiator', access: 'invoice:send' }) class SendInvoice extends QueueJob {}"),
    code("@Job({ access: ['report:run'] }) class Report extends QueueJob {}"),
    code("@Job({ runAs: 'system' }) @SystemTask('nightly purge') class Purge extends QueueJob {}"),
    code("@SystemTask('cleanup') class Cleanup extends QueueJob {}"),
    code('abstract class BaseJob extends QueueJob {}'),
    code('class Seen extends QueueEvent {}'),
    code('class Plain {}'),
  ],
  invalid: [
    { code: code('@Job() class Plain extends QueueJob {}'), errors: [{ messageId: 'undeclaredJob', data: { job: 'Plain' } }] },
    { code: code("@Job({ runAs: 'initiator' }) class Mail extends queue.QueueJob {}"), errors: [{ messageId: 'undeclaredJob', data: { job: 'Mail' } }] },
    { code: code('class Bare extends QueueJob {}'), errors: [{ messageId: 'undeclaredJob', data: { job: 'Bare' } }] },
    { code: code("@Job({ runAs: 'system' }) class Sweep extends QueueJob {}"), errors: [{ messageId: 'undeclaredSystemJob', data: { job: 'Sweep' } }] },
  ],
});
