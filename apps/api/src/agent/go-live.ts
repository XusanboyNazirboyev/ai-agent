import type { PrismaService } from '../persistence/prisma.service.js';
import type { ConnectorSelector } from '../connectors/connector-selector.js';
import { MOCK_CONNECTOR_KEY } from '../connectors/registry/registrations.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { businessProfileOf } from './business-profile.js';

/** What still blocks a real customer from talking to the bot. */
export type GoLiveGap = 'CATALOG' | 'PROFILE';

/**
 * Owner 2026-11-23: the bot goes LIVE for customers only with a real catalog
 * (never the fictional demo one, unless the account is a test account) and
 * with the business name and phone on file. SHADOW and OFF are never gated.
 */
export async function goLiveGaps(
  prisma: Pick<PrismaService, 'tenant'>,
  selector: Pick<ConnectorSelector, 'resolve'>,
  tenantId: string,
  options: { readonly testAccount: boolean },
): Promise<GoLiveGap[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, config: true, packKey: true, packVersion: true },
  });
  const gaps: GoLiveGap[] = [];
  const pack = DOMAIN_PACKS.get(`${tenant.packKey}@${tenant.packVersion}`);
  if (pack?.tools.includes('search_catalog')) {
    const resolution = await selector.resolve(tenantId, 'CATALOG', 'search');
    const row =
      resolution.kind === 'BOUND'
        ? resolution.row
        : resolution.kind === 'UNBOUND' && resolution.candidates.length === 1
          ? resolution.candidates[0]!.row
          : undefined;
    if (
      !row ||
      (row.connectorKey === MOCK_CONNECTOR_KEY && !options.testAccount)
    )
      gaps.push('CATALOG');
  }
  const profile = businessProfileOf(tenant);
  if (!profile.name || !profile.phone) gaps.push('PROFILE');
  return gaps;
}
