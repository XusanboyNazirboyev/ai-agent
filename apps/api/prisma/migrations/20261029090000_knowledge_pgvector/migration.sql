-- Phase 6: knowledge base for RAG on pgvector (additive). Requires the
-- pgvector extension to be installed on the server (CI and docker-compose use
-- the pgvector/pgvector image).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "source" VARCHAR(300) NOT NULL,
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "language" VARCHAR(8),
    "topic" VARCHAR(100),
    "regulated" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "content_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector,
    "embedding_model" VARCHAR(100) NOT NULL,
    "embedding_dims" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_tenant_id_id_key" ON "knowledge_documents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_tenant_id_source_key" ON "knowledge_documents"("tenant_id", "source");

-- CreateIndex
CREATE INDEX "knowledge_documents_tenant_id_status_topic_idx" ON "knowledge_documents"("tenant_id", "status", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_tenant_id_id_key" ON "knowledge_chunks"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_tenant_id_document_id_ordinal_key" ON "knowledge_chunks"("tenant_id", "document_id", "ordinal");

-- CreateIndex
CREATE INDEX "knowledge_chunks_tenant_id_embedding_model_idx" ON "knowledge_chunks"("tenant_id", "embedding_model");

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "knowledge_documents"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Handwritten invariants (not expressible in Prisma).
ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_status_check" CHECK ("status" IN ('ACTIVE', 'ARCHIVED'));
ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_dims_check"
    CHECK ("embedding" IS NULL OR vector_dims("embedding") = "embedding_dims");
