-- Tasks page and reminders before the due time (ADR 068 amendment). Additive.
ALTER TABLE "lead_tasks" ADD COLUMN "remind_at" TIMESTAMPTZ(6);
ALTER TABLE "inbox_events" ADD COLUMN "task_title" VARCHAR(200);
-- The scan now looks at the announce time, not only the due time.
DROP INDEX IF EXISTS "lead_tasks_due_open_idx";
CREATE INDEX "lead_tasks_due_open_idx" ON "lead_tasks"((COALESCE("remind_at", "due_at"))) WHERE "done_at" IS NULL AND "notified_at" IS NULL;
