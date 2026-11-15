-- Tasks and reminders on a lead (roadmap P1.6, ADR 068). Additive.
CREATE TABLE "lead_tasks" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  "assignee_operator_id" UUID,
  "created_by_operator_id" UUID,
  "done_at" TIMESTAMPTZ(6),
  "notified_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_tasks_tenant_id_id_key" ON "lead_tasks"("tenant_id", "id");
CREATE INDEX "lead_tasks_tenant_id_lead_id_idx" ON "lead_tasks"("tenant_id", "lead_id");
-- The reminder scan: open tasks not yet announced, by due time.
CREATE INDEX "lead_tasks_due_open_idx" ON "lead_tasks"("due_at") WHERE "done_at" IS NULL AND "notified_at" IS NULL;
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_lead_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "leads"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_assignee_fkey" FOREIGN KEY ("tenant_id", "assignee_operator_id") REFERENCES "operators"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
