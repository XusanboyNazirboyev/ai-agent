import { describe, expect, it } from 'vitest';
import {
  InvalidTelegramUpdateError,
  normalizeTelegramUpdate,
} from './telegram-normalizer.js';

describe('normalizeTelegramUpdate', () => {
  it('maps a text update into the channel contract without forwarding raw fields', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 9001,
        message: {
          message_id: 42,
          date: 1_800_000_000,
          chat: { id: -100123 },
          from: { id: 77, first_name: 'A', last_name: 'B' },
          text: 'Salom',
          unknown_provider_field: 'discarded',
        },
      }),
    ).toEqual({
      kind: 'text',
      updateId: '9001',
      messageId: '42',
      chatId: '-100123',
      userId: '77',
      displayName: 'A B',
      text: 'Salom',
      receivedAt: new Date(1_800_000_000_000),
    });
  });

  it('ignores valid non-text updates', () => {
    expect(
      normalizeTelegramUpdate({ update_id: 2, edited_message: {} }),
    ).toEqual({
      kind: 'unsupported',
      updateId: '2',
    });
    expect(
      normalizeTelegramUpdate({
        update_id: 3,
        message: {
          message_id: 43,
          date: 1,
          chat: { id: 7 },
          from: { id: 7 },
          voice: { duration: 1 },
        },
      }),
    ).toEqual({ kind: 'unsupported', updateId: '3' });
  });

  it('turns a voice note into an empty-text update carrying the voice (ADR 042)', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 5,
        message: {
          message_id: 45,
          date: 1,
          chat: { id: 7, type: 'private' },
          from: { id: 7, first_name: 'Ali' },
          voice: {
            file_id: 'AwACAgIAAxkBAAIB',
            duration: 4,
            mime_type: 'audio/ogg; codecs=opus',
            file_size: 12_345,
          },
        },
      }),
    ).toMatchObject({
      kind: 'text',
      text: '',
      voice: {
        fileId: 'AwACAgIAAxkBAAIB',
        durationSeconds: 4,
        mimeType: 'audio/ogg',
        fileSize: 12_345,
      },
    });
    // No mime type from the sender: Telegram voice notes are OGG.
    expect(
      normalizeTelegramUpdate({
        update_id: 6,
        message: {
          message_id: 46,
          date: 1,
          chat: { id: 7 },
          from: { id: 7 },
          voice: { file_id: 'x', duration: 2 },
        },
      }),
    ).toMatchObject({ voice: { mimeType: 'audio/ogg' } });
  });

  it('rejects malformed and overlong text updates', () => {
    expect(() => normalizeTelegramUpdate({ update_id: -1 })).toThrow(
      InvalidTelegramUpdateError,
    );
    expect(() =>
      normalizeTelegramUpdate({
        update_id: 4,
        message: {
          message_id: 44,
          date: 1,
          chat: { id: 7 },
          from: { id: 7 },
          text: 'x'.repeat(4_097),
        },
      }),
    ).toThrow(InvalidTelegramUpdateError);
  });
});
