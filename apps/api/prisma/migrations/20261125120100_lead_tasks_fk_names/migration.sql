-- The foreign keys of lead_tasks take Prisma's default names (forward-only fix).
ALTER TABLE "lead_tasks" RENAME CONSTRAINT "lead_tasks_lead_fkey" TO "lead_tasks_tenant_id_lead_id_fkey";
ALTER TABLE "lead_tasks" RENAME CONSTRAINT "lead_tasks_assignee_fkey" TO "lead_tasks_tenant_id_assignee_operator_id_fkey";
