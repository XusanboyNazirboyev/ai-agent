/**
 * One-off contract probe against the owner's Bitrix24 TEST portal (fake data),
 * for the points the official docs leave open (CONNECTOR_PLAN.md "unverified"):
 *   1. can crm.item.list filter leads by originatorId + originId?
 *   2. is valueType MOBILE accepted for a phone in fm?
 *   3. how long may a lead title be?
 *   4. is markup in a timeline comment stored as written? (rendering: look in the portal UI)
 *   5. the portal domain suffix (printed as the suffix only, never the host)
 *
 *   pnpm --filter @agentcore/api exec tsx scripts/bitrix24-probe.ts <out-dir>
 *
 * Only allow-listed methods (Bitrix24Client). The webhook URL is read from
 * CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL (falling back to the older name
 * BITRIX24_WEBHOOK_URL) and is never
 * printed or written; raw responses go to <out-dir> (outside the repository)
 * for scrubbing into CI fixtures.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  Bitrix24Client,
  LEAD_ENTITY_TYPE_ID,
  parseWebhookUrl,
  type Bitrix24Method,
} from '../src/connectors/bitrix24/bitrix24-client.js';
import { isConnectorError } from '../src/connectors/interfaces/errors.js';
import { assertOutsideRepository } from '../src/dev/path-guards.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error('Pass an output directory.');
  // Resolved first, then compared by path segment (./x, ../x and absolute
  // paths alike); anything inside the repository is refused.
  const out = assertOutsideRepository(
    process.argv[2],
    resolve(process.cwd(), '../..'),
  );
  mkdirSync(out, { recursive: true });
  const webhookUrl =
    process.env.CONNECTOR_SECRET_BITRIX24_WEBHOOK_URL ||
    process.env.BITRIX24_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('No Bitrix24 webhook variable set.');
  const base = parseWebhookUrl(webhookUrl);
  const labels = base.hostname.split('.');
  const at = labels.lastIndexOf('bitrix24');
  console.log(
    `5. domain suffix: ${at >= 0 ? labels.slice(at).join('.') : '(no bitrix24 label: custom domain)'}`,
  );

  const client = new Bitrix24Client({ webhookUrl });
  let n = 0;
  const call = async (
    method: Bitrix24Method,
    params: unknown,
  ): Promise<unknown> => {
    n += 1;
    try {
      const response = await client.call(method, params);
      writeFileSync(
        `${out}/${String(n).padStart(2, '0')}-${method}.json`,
        JSON.stringify({ method, params, response }, null, 2),
      );
      return response.result;
    } catch (error: unknown) {
      const code = isConnectorError(error) ? error.code : 'unknown';
      writeFileSync(
        `${out}/${String(n).padStart(2, '0')}-${method}.error.json`,
        JSON.stringify({ method, params, error: code }, null, 2),
      );
      console.log(`   ${method} -> error ${code}`);
      return undefined;
    }
  };

  const mode = await call('crm.settings.mode.get', {});
  console.log(`   CRM mode: ${String(mode)} (1 classic with leads, 2 simple)`);

  const fields = (await call('crm.item.fields', {
    entityTypeId: LEAD_ENTITY_TYPE_ID,
  })) as { fields?: Record<string, Record<string, unknown>> } | undefined;
  for (const name of ['originId', 'originatorId', 'title', 'fm', 'sourceId']) {
    const f = fields?.fields?.[name];
    console.log(
      `   field ${name}: ${f ? JSON.stringify(Object.fromEntries(Object.entries(f).filter(([k]) => !['title', 'upperName', 'settings'].includes(k)))) : 'absent'}`,
    );
  }

  const key = `probe-${Date.now()}`;
  const phone = '+998900000017';
  const created = (await call('crm.item.add', {
    entityTypeId: LEAD_ENTITY_TYPE_ID,
    fields: {
      title: 'Telegram: probe lead (synthetic)',
      name: 'Probe Synthetic',
      sourceId: 'OTHER',
      sourceDescription: 'tezda (Telegram) contract probe',
      comments: 'Synthetic contract probe; safe to delete.',
      originatorId: 'tezda-probe',
      originId: key,
      fm: [{ typeId: 'PHONE', valueType: 'MOBILE', value: phone }],
    },
  })) as { item?: { id?: number } } | undefined;
  const leadId = created?.item?.id;
  console.log(`   crm.item.add -> lead id ${leadId ?? 'none'}`);

  const listed = (await call('crm.item.list', {
    entityTypeId: LEAD_ENTITY_TYPE_ID,
    select: ['*'],
    filter: { originatorId: 'tezda-probe', originId: key },
  })) as { items?: Array<Record<string, unknown>> } | undefined;
  const items = listed?.items ?? [];
  console.log(
    `1. filter by originatorId+originId: ${items.length} item(s); ids match: ${items.length === 1 && items[0]?.id === leadId}`,
  );
  const decoy = (await call('crm.item.list', {
    entityTypeId: LEAD_ENTITY_TYPE_ID,
    select: ['id'],
    filter: { originatorId: 'tezda-probe', originId: `${key}-absent` },
  })) as { items?: unknown[] } | undefined;
  console.log(
    `   ... absent key returns ${decoy?.items?.length ?? 'error'} item(s)`,
  );
  const fm = (items[0]?.fm ?? []) as Array<Record<string, unknown>>;
  const phoneEntry = fm.find((e) => e.typeId === 'PHONE');
  console.log(
    `2. phone valueType stored: ${String(phoneEntry?.valueType ?? 'n/a')}; value preserved: ${phoneEntry?.value === phone}`,
  );

  const dup = (await call('crm.duplicate.findbycomm', {
    type: 'PHONE',
    values: [phone],
  })) as Record<string, unknown> | undefined;
  console.log(
    `   duplicate check keys: ${dup ? Object.keys(dup).join(',') : 'error'}; lead found: ${Array.isArray(dup?.LEAD) && (dup.LEAD as unknown[]).includes(leadId)}`,
  );

  const longTitle = `Telegram: ${'x'.repeat(290)}`;
  const longKey = `${key}-long`;
  await call('crm.item.add', {
    entityTypeId: LEAD_ENTITY_TYPE_ID,
    fields: {
      title: longTitle,
      sourceId: 'OTHER',
      originatorId: 'tezda-probe',
      originId: longKey,
    },
  });
  const longListed = (await call('crm.item.list', {
    entityTypeId: LEAD_ENTITY_TYPE_ID,
    select: ['id', 'title'],
    filter: { originatorId: 'tezda-probe', originId: longKey },
  })) as { items?: Array<{ title?: string }> } | undefined;
  const stored = longListed?.items?.[0]?.title;
  console.log(
    `3. title of ${longTitle.length} chars stored as ${stored === undefined ? 'n/a (refused?)' : `${stored.length} chars`}`,
  );

  if (leadId) {
    const commentId = await call('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: leadId,
        ENTITY_TYPE: 'lead',
        COMMENT:
          'Synthetic probe comment. Markup test: [b]bold-bbcode[/b] <b>bold-html</b> <script>x</script>',
      },
    });
    console.log(
      `4. comment id ${String(commentId ?? 'none')}: check rendering in the portal UI (lead "Telegram: probe lead (synthetic)")`,
    );
  }
  console.log(`requests: ${n}; raw responses in the output directory`);
}

main().catch((error: unknown) => {
  console.error(
    isConnectorError(error)
      ? `probe failed: ${error.code}`
      : error instanceof Error && !/https?:/u.test(error.message)
        ? `probe failed: ${error.message}`
        : 'probe failed',
  );
  process.exitCode = 1;
});
