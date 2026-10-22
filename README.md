# AgentCore

Universal AI sales and support agent platform. `AGENTS.md` is the current project specification.

## Requirements

- Node.js 26 (or Node.js 20.19+)
- pnpm 10+
- Docker with Compose

## Local development

```sh
cp .env.example .env
pnpm install
docker compose up -d
pnpm dev
```

The API listens on port 4000. Check `http://localhost:4000/health` for `{"status":"ok"}`.

The repository is a pnpm workspace: the NestJS API is in `apps/api`, the future web app is reserved in `apps/web`, and shared contracts/configuration live in `packages/`. The web package is a placeholder; no frontend framework is installed yet.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` before submitting changes.
