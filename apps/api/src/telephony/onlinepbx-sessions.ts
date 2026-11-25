import { Injectable } from '@nestjs/common';
import type { OnlinePbxSession } from './onlinepbx-client.js';

/**
 * OnlinePBX sessions by telephony account id, shared by the poller and the
 * call analysis: every `auth.json` issues a new key and the spec warns that
 * frequent re-authentication breaks sessions, so two caches would fight.
 */
@Injectable()
export class OnlinePbxSessions extends Map<string, OnlinePbxSession> {}
