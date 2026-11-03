# Plan: production on AWS, pilot first

Design and open questions: [ADR 035](../adr/035-production-hosting-on-aws-pilot.md) (Proposed). Each step is one branch or one approved AWS action; nothing on AWS is created without the owner's approval of that exact step.

## Step 1: build for production (no AWS, no cost)
- **Images:** production images for `api` and `web` (multi-stage, prod dependencies only, non-root, health check).
- **Compose:** `docker-compose.prod.yml` (api, web, redis, caddy) and a `Caddyfile`.
- **Migrations:** a migrate command run before the new `api` starts.
- **Local proof:** the stack builds and starts locally from the images against a local database, `/health` answers, and the login page loads.
- **Done when:** CI builds both images on every change.

## Step 2: public pages Meta and the law need (no cost)
- **Pages:** `/privacy` (privacy policy) and `/data-deletion` (how to ask for deletion, and what is deleted), public and in en, ru and uz-Latn.
- **Content:** drafted from what the code really stores and which processors it uses (LLM providers, Meta, Telegram, the CRM). Company details stay as placeholders until P4.
- **Caveat:** the draft is marked for legal review, not published as final.

## Step 3: runbooks (no cost)
- **Runbooks:** incident, rollback, queue backlog, connector outage, LLM outage, restore from backup and secret rotation (Phase 9 list).

## Step 4: AWS account and access (owner)
- **Account:** the owner creates the AWS account, enables MFA, and creates a limited IAM user or role for the CLI.
- **CLI:** installed and configured on this computer.
- **Domain:** bought (P2).
- **Budget alarm:** set up first (P3).

## Step 5: staging on AWS (costs money; each step approved)
- **Infrastructure as code:** ECR repositories, VPC and security groups, RDS PostgreSQL (pgvector), EC2 with Docker and the SSM agent, SSM parameters, CloudWatch logs and alarms.
- **First deploy:** with test data only.
- **Checks:**
  - TLS certificate issued for the domain;
  - restore drill from an RDS backup;
  - a short load test;
  - a security review of open ports, IAM and secrets.

## Step 6: CI/CD deploy
- **Builds:** GitHub Actions builds and pushes images to ECR with OIDC (no long-lived AWS keys in GitHub).
- **Deploy:** a manual, approved deploy job runs the migration, then the new containers through SSM.

## Step 7: pilot (after P1)
- **Rollout:** one real project, first in shadow mode (the bot drafts, a person sends), then limited live, then full (roadmap Phase 9).
- **Meta:** the Meta app gets the public domain and goes to App Review.
