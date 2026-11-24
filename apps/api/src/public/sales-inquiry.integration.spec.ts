import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '../config/environment.js';
import type { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { ownerClient } from '../persistence/testing/test-clients.js';
import type { PlatformBotSender } from '../signup/platform-bot.sender.js';
import {
  inquiryText,
  SalesInquiryController,
} from './sales-inquiry.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Sales inquiry tests require agentcore_test');
}
const db = ownerClient();
const phones: string[] = [];
afterAll(async () => {
  await db.salesInquiry.deleteMany({ where: { phone: { in: phones } } });
  await db.$disconnect();
});

const config = (
  values: Record<string, unknown> = {},
): ConfigService<AppEnvironment, true> =>
  ({ get: (key: string) => values[key] }) as never;

function controller(
  values: Record<string, unknown>,
  sent: { chatId: string; text: string }[],
  delivered = true,
): SalesInquiryController {
  const bot = {
    send: (chatId: string, text: string) => {
      sent.push({ chatId, text });
      return Promise.resolve(delivered);
    },
  } as unknown as PlatformBotSender;
  return new SalesInquiryController(
    { db } as unknown as PrivilegedDatabase,
    config(values),
    bot,
  );
}

let n = 0;
function request(): unknown {
  n += 1;
  return { headers: {}, socket: { remoteAddress: `198.51.100.${n}` } };
}
function phone(): string {
  const value = `+998 90 ${String(Date.now()).slice(-7)}${n}`;
  phones.push(value);
  return value;
}

describe('POST /api/v1/public/inquiries', () => {
  it('stores the request and sends it to the sales chat', async () => {
    const sent: { chatId: string; text: string }[] = [];
    const number = phone();
    await expect(
      controller({ SALES_INQUIRY_CHAT_ID: '12345' }, sent).create(
        request() as never,
        {
          name: '  Ali   Valiyev ',
          phone: number,
          company: 'Sayohat Travel',
          locale: 'uz-Latn',
        },
      ),
    ).resolves.toEqual({ ok: true });
    const row = await db.salesInquiry.findFirstOrThrow({
      where: { phone: number },
    });
    expect(row).toMatchObject({
      name: 'Ali Valiyev',
      company: 'Sayohat Travel',
      message: null,
      notified: true,
    });
    expect(sent).toEqual([
      { chatId: '12345', text: expect.stringContaining('Ism: Ali Valiyev') },
    ]);
  });

  it('keeps the request when no chat is set or the message fails', async () => {
    const sent: { chatId: string; text: string }[] = [];
    const quiet = phone();
    await controller({}, sent).create(request() as never, {
      name: 'Vali',
      phone: quiet,
    });
    const failed = phone();
    await controller({ SALES_INQUIRY_CHAT_ID: '1' }, sent, false).create(
      request() as never,
      { name: 'Vali', phone: failed },
    );
    const rows = await db.salesInquiry.findMany({
      where: { phone: { in: [quiet, failed] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.notified)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('refuses a bad body, ignores the hidden field and limits an address', async () => {
    const sent: { chatId: string; text: string }[] = [];
    const api = controller({ SALES_INQUIRY_CHAT_ID: '1' }, sent);
    await expect(
      api.create(request() as never, { name: 'A', phone: 'abc' }),
    ).rejects.toMatchObject({ status: 400 });
    const bot = phone();
    await expect(
      api.create(request() as never, {
        name: 'Spam',
        phone: bot,
        website: 'http://spam.example',
      }),
    ).resolves.toEqual({ ok: true });
    expect(await db.salesInquiry.count({ where: { phone: bot } })).toBe(0);
    const same = request();
    // Each refused body still counts against the address.
    for (let i = 0; i < 5; i += 1)
      await api.create(same as never, { name: 'x' }).catch(() => undefined);
    await expect(
      api.create(same as never, { name: 'x' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(sent).toHaveLength(0);
  });

  it('writes plain text, the customer text only as values', () => {
    expect(inquiryText({ name: '<b>Ali</b>', phone: '+998901234567' })).toBe(
      'tezda: saytdan yangi so‘rov\nIsm: <b>Ali</b>\nTelefon: +998901234567',
    );
  });
});
