import { defineContract } from '@spinajs/http-socket-common';
import type { OpenDoc, DocOpened, Ping } from './socket.js';

export type DocsContract = {
  commands: { 'docs.open': [OpenDoc, DocOpened]; 'docs.close': [OpenDoc, void] };
  events: { 'docs.changed': DocOpened };
  clientEvents: { 'docs.ping': Ping };
};
export const DOCS_CONTRACT = defineContract<DocsContract>();
