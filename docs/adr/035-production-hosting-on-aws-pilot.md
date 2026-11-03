# ADR 035: Production hosting on AWS, pilot first

- **Status:** Proposed, 2026-11-03. Owner decisions are recorded below; the open questions are the owner's. ADR 033 and ADR 034 (other branches) hold numbers 033 and 034.
- **Date:** 2026-11-03
- **Inputs:**
  - roadmap Phase 9 (`docs/spec/12-roadmap.md`);
  - Open Question 9 (hosting, domain, residency, retention);
  - ADR 028 and ADR 032 (encrypted secrets);
  - ADR 030 (alerts as log lines);
  - ADR 031 (Meta needs a public https site for App Review).

## Owner decisions (2026-11-03)
1. **Goal:** make tezda ready for production, on **AWS**.
2. **Architecture:** a **pilot** architecture first, moving to a fully managed one later.
3. **Region:** **eu-central-1 (Frankfurt)**.
4. **Domain:** none yet; one is to be bought.
5. **Access:** AWS is used through the **AWS CLI on the owner's computer**. Claude runs commands, asking before every step that costs money or changes AWS.
6. **Phase gate:** production preparation runs in parallel with the open Phase 7 items (travel eval, live-model eval) and Phase 8 (Instagram live check). This is the owner's decision against rule 10's usual order.

## Context
- **What exists today:**
  - a development-only `Dockerfile` (`pnpm dev`);
  - `docker-compose.yml` for local PostgreSQL (pgvector) and Redis;
  - CI that tests but never deploys;
  - no infrastructure code, no runbook beyond the Telegram dev runbook, and no privacy pages.
- **Meta:** App Review needs a public https site with a privacy policy and a data deletion route (ADR 031).
- **Law (not legal advice; to be confirmed by a lawyer from the official text on lex.uz):**
  - Article 27-1 of Uzbekistan's Law "On Personal Data" (2021) requires personal data of Uzbek citizens to be kept on technical means in Uzbekistan ([Mondaq](https://mondaq.com/data-protection/1197754/the-law-on-personal-data-has-been-amended)).
  - A March 2026 amendment reportedly allows storage abroad under conditions such as an adequate-protection country, but keeps some categories in Uzbekistan, including data of telecom operators' subscribers ([Kun.uz, 2026-03-27](https://kun.uz/en/news/2026/03/27/uzbekistan-amends-personal-data-law-to-facilitate-global-payment-systems)). This is a single news source.
  - AWS has no Uzbekistan region.

## Decision (proposed)
**1. Pilot topology (one region, one account).**
- **EC2:** one instance (size to be priced) runs Docker Compose:
  - `api` (also runs the queue workers and scanners, as today);
  - `web` (Next.js server);
  - `redis`;
  - `caddy` as the reverse proxy, with automatic TLS certificates from Let's Encrypt.
- **RDS for PostgreSQL** (pgvector enabled, automated backups, encryption at rest). It is reached only from the instance's security group.
- **No SSH:** only ports 80 and 443 are open. Administration goes through AWS Systems Manager.

**2. Images and releases.**
- **Images:** production images are multi-stage, have no dev dependencies, run as a non-root user, and are built once per commit. They are pushed to **ECR**.
- **Deploy:** a deploy pulls the tagged images and runs `prisma migrate deploy` before the new `api` starts. Migrations stay additive (rule 5).
- **Rollback:** start the previous image tag again. A migration is never rolled back by dropping anything.

**3. Configuration and secrets.**
- **Where they live:** **SSM Parameter Store** (SecureString). This includes `SECRETS_MASTER_KEY`, `WEB_PROXY_SECRET`, LLM keys, the Meta app secret, Telegram secrets and the database URL.
- **How they arrive:** the instance renders them into an environment file at start; nothing secret is stored in git or in the image.
- **Startup check:** the environment schema already refuses unsafe production settings (test base URLs, insecure cookies, a missing `WEB_PROXY_SECRET`).

**4. Observability and backups.**
- **Logs:** container logs go to **CloudWatch Logs**, and alarms watch the `alert.*` lines (ADR 030), `/health` and disk.
- **Backups:** RDS automated backups with a retention to be set. A restore into a scratch database is drilled before the pilot.

**5. The later move to fully managed.**
- **Target:** the same images move to ECS Fargate behind an ALB, Redis to ElastiCache, and RDS stays.
- **Why the move is cheap:** nothing in the application depends on the instance.

**6. Data, in two steps.**
- **Staging first:** staging on AWS carries test data only.
- **Real customers:** real customer data waits for the lawyer's answer on Article 27-1 (open question P1).

## Open questions (none assumed)
| # | Question | Blocks |
|---|---|---|
| P1 | Lawyer: may customer personal data (names, phone numbers, messages) of Uzbek citizens be stored in Frankfurt under the amended Article 27-1, or must it stay in Uzbekistan? | Real customer data on AWS |
| P2 | Domain name and registrar. | TLS, Meta redirect URI, public pages |
| P3 | Monthly budget for the pilot. The estimate comes from the AWS price list once the size is chosen. | Creating resources |
| P4 | Company details for the privacy policy: legal name, address, contact email, and who answers data requests. | Publishing the privacy pages |
| P5 | Backup retention (days) and data retention for conversations (Open Question 9). | RDS setup; privacy policy |
| P6 | Where alarms go (email address or the Telegram operator group). | Monitoring |

## Consequences
- **Gain:** one way to run tezda in public, with TLS, backups and rollback, and a path to the fully managed setup without rebuilding.
- **Cost:** a monthly AWS bill from the first created resource. Each resource is created only after the owner approves it.
- **Risk:** a single instance is a single point of failure for the API, web and Redis (the database is separate). That is acceptable for a pilot, not for scale.

## Alternatives considered
- **Fully managed from day one (ECS Fargate, ALB, ElastiCache):** more reliable, but costs more and takes longer. Kept as the next step (owner decision 2).
- **Hosting in Uzbekistan:** may be required by P1. If so, the same images and compose file run on a local provider.
