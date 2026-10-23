import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CatalogAttributesSchema,
  ItemTypeSchema,
  normalizeCatalogText,
} from '@agentcore/shared';
import type { CatalogItem, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

export interface NewCatalogItem {
  sourceSystem: string;
  sourceEntityId: string;
  itemType: string;
  title: string;
  description?: string;
  attributes: unknown;
  syncedAt: Date;
  sourceHash: string;
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(tenantId: string, id: string): Promise<CatalogItem | null> {
    return this.prisma.catalogItem.findUnique({
      where: { tenantId_id: { tenantId, id } },
    });
  }

  list(tenantId: string): Promise<CatalogItem[]> {
    return this.prisma.catalogItem.findMany({
      where: { tenantId },
      orderBy: { normalizedTitle: 'asc' },
    });
  }

  async create(tenantId: string, item: NewCatalogItem): Promise<CatalogItem> {
    const attributes = CatalogAttributesSchema.parse(item.attributes);
    const itemType = ItemTypeSchema.parse(item.itemType);
    return this.prisma.catalogItem.create({
      data: {
        ...item,
        itemType,
        tenantId,
        normalizedTitle: normalizeCatalogText(item.title),
        attributes: attributes as Prisma.InputJsonValue,
      },
    });
  }

  async rename(
    tenantId: string,
    id: string,
    title: string,
  ): Promise<CatalogItem> {
    const result = await this.prisma.catalogItem.updateMany({
      where: { tenantId, id },
      data: { title, normalizedTitle: normalizeCatalogText(title) },
    });

    if (result.count === 0)
      throw new NotFoundException('Catalog item not found');

    return this.prisma.catalogItem.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id } },
    });
  }
}
