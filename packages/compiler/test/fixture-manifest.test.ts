import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import type { Manifest } from '@spinajs/manifest';
import { APP_BASIC_MANIFEST, buildFixtureManifest, writeFixtureManifest } from './helpers/fixture-manifest.js';

const read = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;

describe('app-basic manifest fixture', () => {
  before(async () => {
    if (process.env.UPDATE_FIXTURE_MANIFEST) await writeFixtureManifest();
  });

  const manifest = (): Manifest => read(APP_BASIC_MANIFEST);

  it('lists the users controller with four routes', () => {
    const users = manifest().controllers.find((c) => c.className === 'UsersController');
    expect(users?.basePath).to.equal('users');
    expect(users?.routes.map((r) => `${r.method} ${r.fullPath}`)).to.deep.equal([
      'get /users/list',
      'get /users/:id',
      'post /users/create',
      'post /users/:id/avatar',
    ]);
  });

  it('carries derived schemas for every DTO', () => {
    const { schemas } = manifest();
    for (const id of ['UserDto', 'CreateUserDto', 'ValidationProblem', 'ListQuery', 'ChatMessage', 'SendMailJob', 'UserCreated']) {
      expect(schemas, id).to.have.property(`spinajs/app-basic/${id}`);
    }
  });

  it('keeps queue payload schemas free of QueueMessage members', () => {
    const { schemas } = manifest();
    const job = schemas['spinajs/app-basic/SendMailJob'] as { properties: object; additionalProperties: boolean };
    expect(Object.keys(job.properties)).to.deep.equal(['to', 'subject']);
    expect(job.additionalProperties).to.equal(false);
    expect(Object.keys((schemas['spinajs/app-basic/UserCreated'] as { properties: object }).properties)).to.deep.equal(['id']);
  });

  it('has the chat socket controller and two queue messages', () => {
    const m = manifest();
    const chat = m.socketControllers.find((c) => c.className === 'ChatSocketController');
    expect(chat?.prefix).to.equal('chat');
    expect(chat?.commands.map((c) => c.name)).to.deep.equal(['send', 'history']);
    expect(chat?.commands[0].options.idempotent).to.equal(true);
    expect(chat?.events.map((e) => e.name)).to.deep.equal(['message']);
    expect(m.queueMessages.map((q) => `${q.kind}:${q.className}`)).to.deep.equal(['job:SendMailJob', 'event:UserCreated']);
  });

  it('streams the history result as ChatMessage items', () => {
    const history = manifest().socketControllers[0].commands.find((c) => c.name === 'history');
    expect(history?.result).to.deep.equal({ text: 'ChatMessage', schema: 'spinajs/app-basic/ChatMessage' });
    expect(history?.stream).to.equal(true);
  });

  it('maps ResourceNotFound to the UserNotFound response with status 404', () => {
    const entry = manifest().values.find((v) => v.token === '__http_error_map__' && v.mapKey === 'ResourceNotFound');
    expect(entry?.value).to.deep.equal({ response: 'UserNotFound', status: 404 });
  });

  it('derives no schema for the uploaded file and no framework file schemas', () => {
    const m = manifest();
    const avatar = m.controllers.find((c) => c.className === 'UsersController')?.routes[3];
    expect(avatar?.params[1].runtimeType.schema).to.equal(undefined);
    expect(Object.keys(m.schemas).filter((id) => /\/(File|IFileInfo|fs|IUploadedFile_any)$/.test(id))).to.deep.equal([]);
    expect(m.diagnostics.filter((d) => d.severity !== 'info')).to.deep.equal([]);
  });

  it('declares the hooks and app config modules', () => {
    expect(manifest().configModules.map((c) => c.module)).to.include.members(['hooks', 'app']);
  });

  it('matches a fresh build apart from generatedAt', async () => {
    const fresh = await buildFixtureManifest();
    expect({ ...manifest(), generatedAt: '' }).to.deep.equal({ ...fresh, generatedAt: '' });
  });
});
