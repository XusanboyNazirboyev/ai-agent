import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';

interface StoredFact {
  id: string;
  value: {
    kind: string;
    confirmedQuote?: boolean;
    money?: { amount: string; currency: string };
    pricingBasis?: string;
  };
  provenance: {
    sourceSystem: string;
    sourceEntityId: string;
    offerSourceEntityId?: string;
    retrievedAt: string;
    validUntil?: string;
    offerId?: string;
    tool: string;
  };
}

/**
 * Records what the customer was actually shown. Called only after the
 * outgoing message was delivered (delivery state SENT): a draft, a failed
 * send or an ambiguous send never counts. The facts are the exact verified
 * facts of the turn that wrote the message, restricted to the fact ids that
 * appear in the reply. A `Quote` row is created only for a live confirmed
 * quote whose offer exists in the synced catalog (its foreign key); every
 * other case is stored with the reason it was not. Idempotent per
 * (message, offer), so retried deliveries cannot duplicate anything.
 */
@Injectable()
export class ShownOffersService {
  constructor(private readonly prisma: PrismaService) {}

  async recordDelivered(tenantId: string, messageId: string): Promise<number> {
    const turn = await this.prisma.agentTurn.findFirst({
      where: { tenantId, replyMessageId: messageId, status: 'COMMITTED' },
      select: { conversationId: true, facts: true, shownFactIds: true },
    });
    if (!turn) return 0;
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, tenantId, deliveryState: 'SENT' },
      select: { id: true, createdAt: true },
    });
    if (!message) return 0;
    const ids = new Set(
      Array.isArray(turn.shownFactIds) ? (turn.shownFactIds as string[]) : [],
    );
    const facts = (
      Array.isArray(turn.facts) ? (turn.facts as unknown as StoredFact[]) : []
    ).filter((fact) => ids.has(fact.id));
    if (facts.length === 0) return 0;
    // Group by offer; title facts carry the item, so they join their offer
    // only when no offer fact exists (an item shown on its own).
    const groups = new Map<string, StoredFact[]>();
    for (const fact of facts) {
      const ref =
        fact.provenance.offerId ?? `item:${fact.provenance.sourceEntityId}`;
      groups.set(ref, [...(groups.get(ref) ?? []), fact]);
    }
    let recorded = 0;
    for (const [offerRef, group] of groups) {
      const quote = group.find(
        (fact) =>
          fact.value.kind === 'price' && fact.value.confirmedQuote === true,
      );
      // Catalog sync keys offers by their source id; facts carry the
      // canonical id in `offerId` and the source id beside it (DEF-001).
      const syncedKey =
        group.find((fact) => fact.provenance.offerSourceEntityId)?.provenance
          .offerSourceEntityId ?? offerRef;
      const offer = offerRef.startsWith('item:')
        ? null
        : await this.prisma.offer.findFirst({
            where: {
              tenantId,
              sourceEntityId: syncedKey,
              sourceSystem:
                quote?.provenance.sourceSystem ??
                group[0].provenance.sourceSystem,
            },
            select: { id: true },
          });
      let quoteRecorded = false;
      let skipReason: string | null = null;
      try {
        await this.prisma.$transaction(async (tx) => {
          const row = await tx.shownOffer.createMany({
            data: [
              {
                tenantId,
                conversationId: turn.conversationId,
                messageId,
                offerRef,
                offerId: offer?.id ?? null,
                facts: group as unknown as Prisma.InputJsonValue,
                shownAt: new Date(),
              },
            ],
            skipDuplicates: true,
          });
          if (row.count === 0) return; // already recorded (retry)
          recorded += 1;
          if (!quote?.value.money) {
            skipReason = quote ? 'NO_AMOUNT' : 'NOT_A_CONFIRMED_QUOTE';
          } else if (!offer) {
            skipReason = 'OFFER_NOT_SYNCED';
          } else {
            await tx.quote.createMany({
              data: [
                {
                  tenantId,
                  offerId: offer.id,
                  conversationId: turn.conversationId,
                  amount: new Prisma.Decimal(quote.value.money.amount),
                  currency: quote.value.money.currency,
                  pricingBasis: (quote.value.pricingBasis ??
                    'UNSPECIFIED') as 'UNSPECIFIED',
                  breakdown: {},
                  sourceSystem: quote.provenance.sourceSystem,
                  sourceEntityId: quote.provenance.sourceEntityId,
                  retrievedAt: new Date(quote.provenance.retrievedAt),
                  validUntil: quote.provenance.validUntil
                    ? new Date(quote.provenance.validUntil)
                    : null,
                  snapshot: quote as unknown as Prisma.InputJsonValue,
                  shownInMessageId: messageId,
                },
              ],
              skipDuplicates: true,
            });
            quoteRecorded = true;
          }
          await tx.shownOffer.updateMany({
            where: { tenantId, messageId, offerRef },
            data: { quoteRecorded, quoteSkipReason: skipReason },
          });
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          continue;
        throw error;
      }
    }
    return recorded;
  }
}
