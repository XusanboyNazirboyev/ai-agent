import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';

/** Inclusive calendar days in the tenant's time zone, as YYYY-MM-DD. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface AnalyticsReport {
  range: { from: string; to: string; timezone: string; days: number };
  conversations: {
    total: number;
    byLanguage: { language: string; count: number }[];
    daily: { day: string; count: number }[];
  };
  firstResponse: {
    asked: number;
    answered: number;
    p50Seconds: number | null;
    p95Seconds: number | null;
  };
  resolution: {
    total: number;
    autoResolved: number;
    handedOver: number;
    autoResolvedRate: number | null;
    handoverRate: number | null;
  };
  handovers: {
    total: number;
    byReason: { reason: string; count: number }[];
    daily: { day: string; count: number }[];
    takeOverP50Seconds: number | null;
    slaAlerted: number;
  };
  leads: {
    total: number;
    byScore: { score: string; count: number }[];
    captureRate: number | null;
    crmFailed: number;
    crmPending: number;
  };
  guardrail: {
    turns: number;
    blockedTurns: number;
    blockRate: number | null;
    guardrailHandovers: number;
  };
  latency: { turns: number; p50Ms: number | null; p95Ms: number | null };
  cost: {
    conversationsWithTurns: number;
    totalUsd: number;
    perConversationUsd: number | null;
    inputTokens: number;
    outputTokens: number;
  };
  tools: { calls: number; errors: number; errorRate: number | null };
  languageDetection: {
    messages: number;
    averageConfidence: number | null;
    lowConfidence: number;
  };
}

const MAX_DAYS = 366;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? part / whole : null;
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export class RangeError_ extends Error {
  constructor() {
    super('Invalid date range');
  }
}

/** Fills the days without rows so a chart has one point per calendar day. */
function fill(
  days: string[],
  rows: { day: string; count: number }[],
): { day: string; count: number }[] {
  const byDay = new Map(rows.map((row) => [row.day, row.count]));
  return days.map((day) => ({ day, count: byDay.get(day) ?? 0 }));
}

/**
 * Read-only metrics of one tenant for a date range (Section 11 / 12A.6),
 * computed from the existing tables: no new data is collected. Every query is
 * bound to the tenant id; day buckets use the tenant's time zone; customer
 * text is never selected. "Auto-resolved" means: the bot answered at least
 * once and no handover was ever opened for that conversation.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    tenantId: string,
    range?: Partial<DateRange>,
  ): Promise<AnalyticsReport> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const tz = tenant.timezone;
    const today = (
      await this.prisma.$queryRaw<{ d: string }[]>`
        SELECT to_char((now() AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS d`
    )[0].d;
    const to = range?.to ?? today;
    const from =
      range?.from ??
      (
        await this.prisma.$queryRaw<{ d: string }[]>`
          SELECT to_char(${to}::date - 29, 'YYYY-MM-DD') AS d`
      )[0].d;
    if (!DAY.test(from) || !DAY.test(to)) throw new RangeError_();
    const bounds = (
      await this.prisma.$queryRaw<{ days: number }[]>`
        SELECT ((${to}::date) - (${from}::date) + 1)::int AS days`
    )[0];
    if (bounds.days < 1 || bounds.days > MAX_DAYS) throw new RangeError_();
    // The bounds stay inside SQL: a JS Date parameter would be read in the
    // database session's time zone and shift every day by that offset.
    const start = Prisma.sql`((${from}::date)::timestamp AT TIME ZONE ${tz})`;
    const end = Prisma.sql`(((${to}::date) + 1)::timestamp AT TIME ZONE ${tz})`;
    const days = (
      await this.prisma.$queryRaw<{ day: string }[]>`
        SELECT to_char(d::date, 'YYYY-MM-DD') AS day
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d`
    ).map((row) => row.day);

    const q = this.prisma;
    const [
      languages,
      convDaily,
      first,
      resolution,
      handoverReasons,
      handoverDaily,
      handoverTimes,
      leadScores,
      leadCrm,
      turns,
      toolStats,
      detection,
    ] = await Promise.all([
      q.$queryRaw<{ language: string; count: number }[]>`
        SELECT COALESCE(language, 'unknown') AS language, count(*)::int AS count
        FROM conversations
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${start} AND created_at < ${end}
        GROUP BY 1 ORDER BY 2 DESC, 1`,
      q.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM conversations
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${start} AND created_at < ${end}
        GROUP BY 1`,
      q.$queryRaw<
        {
          asked: number;
          answered: number;
          p50: number | null;
          p95: number | null;
        }[]
      >`
        WITH first AS (
          SELECT c.id,
            min(m.created_at) FILTER (WHERE m.direction = 'INBOUND') AS first_in,
            min(m.created_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type IN ('BOT', 'OPERATOR')) AS first_out
          FROM conversations c
          JOIN messages m ON m.tenant_id = c.tenant_id AND m.conversation_id = c.id
          WHERE c.tenant_id = ${tenantId}::uuid AND c.created_at >= ${start} AND c.created_at < ${end}
          GROUP BY c.id)
        SELECT count(*) FILTER (WHERE first_in IS NOT NULL)::int AS asked,
          count(*) FILTER (WHERE first_in IS NOT NULL AND first_out >= first_in)::int AS answered,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_out - first_in))
            FILTER (WHERE first_in IS NOT NULL AND first_out >= first_in) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM first_out - first_in))
            FILTER (WHERE first_in IS NOT NULL AND first_out >= first_in) AS p95
        FROM first`,
      q.$queryRaw<{ total: number; auto: number; handed: number }[]>`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
                AND m.author_type = 'BOT' AND m.direction = 'OUTBOUND')
            AND NOT EXISTS (
              SELECT 1 FROM handovers h WHERE h.tenant_id = c.tenant_id AND h.conversation_id = c.id))::int AS auto,
          count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM handovers h WHERE h.tenant_id = c.tenant_id AND h.conversation_id = c.id))::int AS handed
        FROM conversations c
        WHERE c.tenant_id = ${tenantId}::uuid AND c.created_at >= ${start} AND c.created_at < ${end}`,
      q.$queryRaw<{ reason: string; count: number }[]>`
        SELECT reason_code AS reason, count(*)::int AS count
        FROM handovers
        WHERE tenant_id = ${tenantId}::uuid AND opened_at >= ${start} AND opened_at < ${end}
        GROUP BY 1 ORDER BY 2 DESC, 1`,
      q.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(date_trunc('day', opened_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM handovers
        WHERE tenant_id = ${tenantId}::uuid AND opened_at >= ${start} AND opened_at < ${end}
        GROUP BY 1`,
      q.$queryRaw<{ p50: number | null; alerted: number }[]>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM taken_at - opened_at))
                 FILTER (WHERE taken_at IS NOT NULL) AS p50,
               count(*) FILTER (WHERE sla_alerted_at IS NOT NULL)::int AS alerted
        FROM handovers
        WHERE tenant_id = ${tenantId}::uuid AND opened_at >= ${start} AND opened_at < ${end}`,
      q.$queryRaw<{ score: string; count: number }[]>`
        SELECT score::text AS score, count(*)::int AS count
        FROM leads
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${start} AND created_at < ${end}
        GROUP BY 1`,
      q.$queryRaw<{ failed: number; pending: number }[]>`
        SELECT count(*) FILTER (WHERE crm_sync_status = 'FAILED')::int AS failed,
               count(*) FILTER (WHERE crm_sync_status = 'PENDING')::int AS pending
        FROM leads
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${start} AND created_at < ${end}`,
      q.$queryRaw<
        {
          turns: number;
          blocked: number;
          guardrail_handovers: number;
          convs: number;
          cost_nano: bigint | null;
          input_tokens: bigint | null;
          output_tokens: bigint | null;
          p50: number | null;
          p95: number | null;
          timed: number;
        }[]
      >`
        SELECT count(*)::int AS turns,
          count(*) FILTER (WHERE jsonb_typeof(guardrail -> 'violations') = 'array'
            AND jsonb_array_length(guardrail -> 'violations') > 0)::int AS blocked,
          count(*) FILTER (WHERE handover_reason = 'GUARDRAIL')::int AS guardrail_handovers,
          count(DISTINCT conversation_id)::int AS convs,
          sum(actual_cost_nano_usd) AS cost_nano,
          sum(input_tokens) AS input_tokens,
          sum(output_tokens) AS output_tokens,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS p95,
          count(*) FILTER (WHERE latency_ms IS NOT NULL)::int AS timed
        FROM agent_turns
        WHERE tenant_id = ${tenantId}::uuid AND status = 'COMMITTED'
          AND created_at >= ${start} AND created_at < ${end}`,
      q.$queryRaw<{ calls: number; errors: number }[]>`
        SELECT count(*)::int AS calls,
               count(*) FILTER (WHERE t ->> 'status' IS DISTINCT FROM 'ok')::int AS errors
        FROM agent_turns a, jsonb_array_elements(a.tool_calls) AS t
        WHERE a.tenant_id = ${tenantId}::uuid AND a.status = 'COMMITTED'
          AND a.created_at >= ${start} AND a.created_at < ${end}
          AND jsonb_typeof(a.tool_calls) = 'array'`,
      q.$queryRaw<{ messages: number; avg: number | null; low: number }[]>`
        SELECT count(*)::int AS messages,
               avg(language_confidence)::float8 AS avg,
               count(*) FILTER (WHERE language_confidence < 0.5)::int AS low
        FROM messages
        WHERE tenant_id = ${tenantId}::uuid AND direction = 'INBOUND'
          AND language_confidence IS NOT NULL
          AND created_at >= ${start} AND created_at < ${end}`,
    ]);

    const f = first[0];
    const r = resolution[0];
    const h = handoverTimes[0];
    const g = turns[0];
    const t = toolStats[0] ?? { calls: 0, errors: 0 };
    const d = detection[0];
    const totalCostUsd = Number(g.cost_nano ?? 0n) / 1e9;
    const leadTotal = leadScores.reduce((sum, row) => sum + row.count, 0);
    const handoverTotal = handoverReasons.reduce(
      (sum, row) => sum + row.count,
      0,
    );
    const scoreOrder = ['HOT', 'WARM', 'COLD'];
    return {
      range: { from, to, timezone: tz, days: bounds.days },
      conversations: {
        total: r.total,
        byLanguage: languages,
        daily: fill(days, convDaily),
      },
      firstResponse: {
        asked: f.asked,
        answered: f.answered,
        p50Seconds: num(f.p50),
        p95Seconds: num(f.p95),
      },
      resolution: {
        total: r.total,
        autoResolved: r.auto,
        handedOver: r.handed,
        autoResolvedRate: ratio(r.auto, r.total),
        handoverRate: ratio(r.handed, r.total),
      },
      handovers: {
        total: handoverTotal,
        byReason: handoverReasons,
        daily: fill(days, handoverDaily),
        takeOverP50Seconds: num(h.p50),
        slaAlerted: h.alerted,
      },
      leads: {
        total: leadTotal,
        byScore: scoreOrder.map((score) => ({
          score,
          count: leadScores.find((row) => row.score === score)?.count ?? 0,
        })),
        captureRate: ratio(leadTotal, r.total),
        crmFailed: leadCrm[0].failed,
        crmPending: leadCrm[0].pending,
      },
      guardrail: {
        turns: g.turns,
        blockedTurns: g.blocked,
        blockRate: ratio(g.blocked, g.turns),
        guardrailHandovers: g.guardrail_handovers,
      },
      latency: { turns: g.timed, p50Ms: num(g.p50), p95Ms: num(g.p95) },
      cost: {
        conversationsWithTurns: g.convs,
        totalUsd: totalCostUsd,
        perConversationUsd: g.convs > 0 ? totalCostUsd / g.convs : null,
        inputTokens: Number(g.input_tokens ?? 0n),
        outputTokens: Number(g.output_tokens ?? 0n),
      },
      tools: {
        calls: t.calls,
        errors: t.errors,
        errorRate: ratio(t.errors, t.calls),
      },
      languageDetection: {
        messages: d.messages,
        averageConfidence: num(d.avg),
        lowConfidence: d.low,
      },
    };
  }
}
