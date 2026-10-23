import { Module } from '@nestjs/common';
import { CatalogRepository } from './catalog.repository.js';
import { PrismaService } from './prisma.service.js';

@Module({
  providers: [PrismaService, CatalogRepository],
  exports: [PrismaService, CatalogRepository],
})
export class PersistenceModule {}
