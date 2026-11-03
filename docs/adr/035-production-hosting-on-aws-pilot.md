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

## Amendment 1 (2026-11-03): the AWS account and the first host
Done by the owner in the AWS console.
- **First account (project "Fresh Canvas"):** opened through "Sign up for AWS (new)". Such accounts cannot choose a Region; AWS assigned Asia Pacific (Sydney) from the contact address ([AWS Regions for your projects](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html), read 2026-11-03). Its console showed the free plan with $140 credits. A first instance was launched there by mistake; whether it is terminated is not checked (the CLI is not signed in to that account).
- **Owner decision:** keep Frankfurt. Instead of activating advanced features (irreversible, [docs](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html)), the owner opened a second, standalone account (not in an organization) and reports choosing the free plan at sign-up. **Unresolved:** on 2026-11-03 the Free Tier API (`aws freetier get-account-plan-state`) returns plan `PAID` with 0 remaining credits for this account, and Billing → Credits shows $0.00 (the page says it updates about every 24 hours). Until that is settled, costs are treated as possibly charged. Cost guard: a zero spend budget (owner-reported, not checked here).
- **CLI:** AWS CLI 2.39.3 on the owner's Mac, profile `tezda` through `aws login`; it currently signs in as the account's root user, to be replaced by a non-root identity before anything is created from the CLI.
- **Host:** `tezda-staging`, `t4g.small` (2 vCPU, 2 GiB, arm64; the Mac builds arm64 images natively) in `eu-central-1c`, Ubuntu Server 24.04 LTS instead of Amazon Linux (both ship the SSM agent; Docker's own apt repository supports Ubuntu), 30 GiB gp3 encrypted, IMDSv2 only, credit specification Standard.
- **Access:** no key pair and no port 22; the security group allows only 80 and 443 from anywhere. Shell through SSM Session Manager with the instance role `tezda-ec2-ssm` (`AmazonSSMManagedInstanceCore`, `CloudWatchAgentServerPolicy`).
- **Installed:** Docker Engine and Compose v5.7.0 from Docker's apt repository ([docs](https://docs.docker.com/engine/install/ubuntu/), read 2026-11-03) and a 2 GiB swap file in `/etc/fstab`; `hello-world` ran.
- **Not done:** RDS, ECR, SSM parameters, CloudWatch, an Elastic IP, a domain, and any deploy. The Sydney `launch-wizard-1` security group and an unused IAM role `InstanceRole` are left to remove.

## Amendment 2 (2026-11-03): PostgreSQL on the host for staging
- **Owner decision:** staging runs PostgreSQL (pgvector, the same `pgvector/pgvector:pg16` image as local development) in a container on the EC2 host instead of RDS. Why: RDS `db.t4g.micro` with 20 GB gp3 adds about $16.6 a month in Frankfurt ($0.019 an hour and $0.137 per GB-month, AWS price list of 2026-10-29). The owner accepts the costs even if the account turns out to be on the paid plan, and may move to RDS later.
- **How:** `deploy/docker-compose.local-db.yml` adds the `postgres` service with a named volume and makes `migrate` and `api` wait for it; the app connects with `POSTGRES_HOST=postgres` and `POSTGRES_SSL_MODE=disable` (the connection stays on the host's Docker network). Nothing else changes, so moving to RDS is a dump, a restore and new `POSTGRES_*` values.
- **Backups:** `deploy/backup-postgres.sh` writes a daily `pg_dump` to `/var/backups/tezda` and deletes dumps older than `BACKUP_KEEP_DAYS` (no default in the script; the owner set 7 days on 2026-11-03, P5). Checked on a throwaway local container: the dump restored into a new database with its rows and the `vector` extension.
- **Gives up, for now:** RDS's automated backups and point-in-time restore, and backups that survive losing the instance (the dumps are on its disk). An off-host copy (for example S3) is still open.

## Amendment 3 (2026-11-03): images on ghcr.io, a temporary staging address
- **Images:** `ghcr.io/xusanboynazirboyev/tezda-{api,web,migrate}:<commit>` instead of ECR. Why: the repository is public, and GitHub states that container image storage and bandwidth are currently free and that it gives at least a month's notice before charging ([GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages), read 2026-11-03); ECR would cost $0.10 per GB-month (AWS price list, Frankfurt). The packages are to be public (owner: "whichever is safe"; set by the owner in each package's settings), so the host pulls without a stored token. Checked before publishing: no `.env`, key or certificate files other than the system CA bundles in the images. The first build is arm64 from the owner's Mac (commit `71ea82b`); CI builds come with step 6.
- **Address:** no domain yet (P2), so staging uses `18-185-27-82.sslip.io`, a public wildcard DNS name that resolves to the embedded IP, with a Let's Encrypt certificate from Caddy. The instance got an Elastic IP (`18.185.27.82`) so the name survives a stop and start; while attached it costs the same $0.005 an hour as the public IPv4 it replaced (AWS price list). Meta App Review still needs a real domain.
- **Setup:** `deploy/bootstrap-staging.sh` clones `deploy/` to `/opt/tezda`, generates `.env.production` on the host (secrets never leave it), pulls the tag, migrates, starts and installs the daily backup cron (7 days). The LLM provider stays at the API default until real keys are added. The first login comes from `deploy/create-owner.sh` (a tenant and its OWNER; the password goes to `/var/lib/tezda-secrets`, never to the screen or logs).

## Open questions (none assumed)
| # | Question | Blocks |
|---|---|---|
| P1 | Lawyer: may customer personal data (names, phone numbers, messages) of Uzbek citizens be stored in Frankfurt under the amended Article 27-1, or must it stay in Uzbekistan? | Real customer data on AWS |
| P2 | Domain name and registrar. | TLS, Meta redirect URI, public pages |
| P3 | Monthly budget for the pilot. The estimate comes from the AWS price list once the size is chosen. | Creating resources |
| P4 | Company details for the privacy policy: legal name, address, contact email, and who answers data requests. | Publishing the privacy pages |
| P5 | Data retention for conversations (Open Question 9). Backup retention is answered: 7 days (owner, 2026-11-03). | Privacy policy |
| P6 | Where alarms go (email address or the Telegram operator group). | Monitoring |

## Consequences
- **Gain:** one way to run tezda in public, with TLS, backups and rollback, and a path to the fully managed setup without rebuilding.
- **Cost:** a monthly AWS bill from the first created resource. Each resource is created only after the owner approves it.
- **Risk:** a single instance is a single point of failure for the API, web and Redis (the database is separate). That is acceptable for a pilot, not for scale.

## Alternatives considered
- **Fully managed from day one (ECS Fargate, ALB, ElastiCache):** more reliable, but costs more and takes longer. Kept as the next step (owner decision 2).
- **Hosting in Uzbekistan:** may be required by P1. If so, the same images and compose file run on a local provider.
