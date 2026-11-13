-- ADR 058: before this release the agent never moved a lead between stages,
-- so every lead that sits outside the first stage of its pipeline was placed
-- there by an operator. Mark those as operator-staged so that enabling AI
-- staging later never moves them. Idempotent: only rows still marked AGENT
-- with no recorded stage move are touched.
UPDATE "leads" AS l
SET "stage_set_by" = 'OPERATOR', "stage_set_at" = l."updated_at"
FROM "lead_stages" AS s
WHERE l."pipeline_stage_id" = s."id"
  AND l."tenant_id" = s."tenant_id"
  AND l."stage_set_by" = 'AGENT'
  AND l."stage_set_at" IS NULL
  AND s."position" > (
    SELECT MIN(f."position") FROM "lead_stages" AS f
    WHERE f."tenant_id" = s."tenant_id" AND f."pipeline_id" = s."pipeline_id"
      AND f."archived_at" IS NULL
  );
