import { config as loadEnv } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { traceRequests } from "../observability/trace-requests.js";
import {
  appModuleEnvironment,
  ownerClient,
} from "../persistence/testing/test-clients.js";
import { hashPassword } from "../webinbox/password.js";

/**
 * ADR 096 over HTTP on the real AppModule and database: one sign-in endpoint
 * for tenant operators and platform admins, the "choose" answer when both
 * accept the password, and failures that count on every identity.
 */
loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== "agentcore_test")
  throw new Error("Sign-in tests require agentcore_test");
for (const key of [
  "HOST",
  "PORT",
  "DATABASE",
  "USER",
  "PASSWORD",
  "SSL_MODE",
]) {
  const value = process.env[`TEST_POSTGRES_${key}`];
  if (value !== undefined) process.env[`POSTGRES_${key}`] = value;
}
Object.assign(process.env, appModuleEnvironment());
process.env.NODE_ENV = "test";
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("base64");
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = "1000";
process.env.WEB_ORIGINS = "http://localhost:3000";
delete process.env.WEB_PROXY_SECRET;

const FAST = { N: 1024, r: 8, p: 1 };
const PASSWORD = "sign-in test password";
const db = ownerClient();
const suffix = randomUUID().slice(0, 8);
let app: INestApplication;
let base = "";
let tenantId = "";

beforeAll(async () => {
  const tenant = await db.tenant.create({
    data: {
      slug: `sign-in-${suffix}`,
      name: "Sign-in test",
      defaultLocale: "en",
      supportedLocales: ["en"],
      timezone: "Asia/Tashkent",
      packKey: "education",
      packVersion: "1",
    },
  });
  tenantId = tenant.id;
  const { AppModule } = await import("../app.module.js");
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  app.use(traceRequests);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

async function operator(email: string, password = PASSWORD): Promise<void> {
  const row = await db.operator.create({
    data: { tenantId, displayName: email, role: "ADMIN" },
  });
  await db.operatorCredential.create({
    data: {
      tenantId,
      operatorId: row.id,
      email,
      passwordHash: await hashPassword(password, FAST),
    },
  });
}

async function admin(
  email: string,
  password = PASSWORD,
  isActive = true,
): Promise<void> {
  await db.platformAdmin.create({
    data: {
      email,
      displayName: email,
      role: "PLATFORM_SUPPORT",
      isActive,
      passwordHash: await hashPassword(password, FAST),
    },
  });
}

async function signIn(
  body: Record<string, unknown>,
): Promise<{
  status: number;
  body: Record<string, unknown>;
  cookies: string[];
}> {
  const response = await fetch(`${base}/api/v1/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    cookies: response.headers.getSetCookie(),
  };
}

const email = (label: string): string => `${label}-${suffix}@example.test`;

const failures = async (
  address: string,
): Promise<{ tenant?: number; platform?: number }> => ({
  tenant: (
    await db.operatorCredential.findUnique({ where: { email: address } })
  )?.failedAttempts,
  platform: (await db.platformAdmin.findUnique({ where: { email: address } }))
    ?.failedAttempts,
});

describe("one sign-in endpoint (ADR 096)", () => {
  it("opens the business panel for a tenant-only e-mail", async () => {
    await operator(email("tenant"));
    const result = await signIn({
      email: email("tenant").toUpperCase(),
      password: PASSWORD,
    });
    expect(result.status).toBe(200);
    expect(result.body.panel).toBe("app");
    expect(result.body.operator).toBeDefined();
    expect(result.cookies.some((c) => c.startsWith("ac_session="))).toBe(true);
  });

  it("starts the console flow for a console-only e-mail, with no tenant cookie", async () => {
    await admin(email("console"));
    const result = await signIn({
      email: email("console"),
      password: PASSWORD,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      panel: "console",
      mfaEnrollmentRequired: true,
    });
    expect(result.cookies).toEqual([]);
  });

  it("asks once when both accept the password, then opens only the chosen one", async () => {
    const both = email("both");
    await operator(both);
    await admin(both);
    const sessionsBefore = await db.operatorSession.count({
      where: { tenantId },
    });
    const ask = await signIn({ email: both, password: PASSWORD });
    expect(ask.body).toEqual({ panel: "choose" });
    expect(ask.cookies).toEqual([]);
    expect(await db.operatorSession.count({ where: { tenantId } })).toBe(
      sessionsBefore,
    );

    const appSide = await signIn({
      email: both,
      password: PASSWORD,
      panel: "app",
    });
    expect(appSide.body.panel).toBe("app");
    expect(appSide.cookies.some((c) => c.startsWith("ac_session="))).toBe(true);
    const consoleSide = await signIn({
      email: both,
      password: PASSWORD,
      panel: "console",
    });
    expect(consoleSide.body).toMatchObject({
      panel: "console",
      mfaEnrollmentRequired: true,
    });
    expect(consoleSide.cookies).toEqual([]);
  });

  it("opens the one identity whose password matches when the e-mail is in both", async () => {
    const split = email("split");
    await operator(split, "tenant password only");
    await admin(split);
    const result = await signIn({
      email: split,
      password: "tenant password only",
    });
    expect(result.body.panel).toBe("app");
    expect(await failures(split)).toEqual({ tenant: 0, platform: 0 });
  });

  it("counts a wrong password on every identity with the e-mail", async () => {
    const wrong = email("wrong");
    await operator(wrong);
    await admin(wrong);
    const result = await signIn({ email: wrong, password: "not it" });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe("INVALID_CREDENTIALS");
    expect(await failures(wrong)).toEqual({ tenant: 1, platform: 1 });
  });

  it("a locked console identity never blocks the tenant login, and the reverse", async () => {
    const locked = email("locked");
    await operator(locked);
    await admin(locked);
    const until = new Date(Date.now() + 60_000);
    await db.platformAdmin.update({
      where: { email: locked },
      data: { lockedUntil: until },
    });
    expect(
      (await signIn({ email: locked, password: PASSWORD })).body.panel,
    ).toBe("app");

    await db.platformAdmin.update({
      where: { email: locked },
      data: { lockedUntil: null },
    });
    await db.operatorCredential.update({
      where: { email: locked },
      data: { lockedUntil: until },
    });
    expect(
      (await signIn({ email: locked, password: PASSWORD })).body.panel,
    ).toBe("console");
    const wrong = await signIn({ email: locked, password: "not it" });
    expect(wrong.body.code).toBe("LOCKED");
  });

  it("refuses an unknown e-mail and an inactive admin like a wrong password", async () => {
    const unknown = await signIn({
      email: email("nobody"),
      password: PASSWORD,
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe("INVALID_CREDENTIALS");

    await admin(email("inactive"), PASSWORD, false);
    const inactive = await signIn({
      email: email("inactive"),
      password: PASSWORD,
    });
    expect(inactive.status).toBe(401);
    expect((await failures(email("inactive"))).platform).toBe(1);
  });

  it("keeps the suspended-tenant answer of the tenant flow", async () => {
    const tenant = await db.tenant.create({
      data: {
        slug: `sign-in-s-${suffix}`,
        name: "Suspended",
        defaultLocale: "en",
        supportedLocales: ["en"],
        timezone: "Asia/Tashkent",
        packKey: "education",
        packVersion: "1",
        status: "SUSPENDED",
      },
    });
    const row = await db.operator.create({
      data: { tenantId: tenant.id, displayName: "suspended", role: "OWNER" },
    });
    await db.operatorCredential.create({
      data: {
        tenantId: tenant.id,
        operatorId: row.id,
        email: email("suspended"),
        passwordHash: await hashPassword(PASSWORD, FAST),
      },
    });
    const result = await signIn({
      email: email("suspended"),
      password: PASSWORD,
    });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("TENANT_SUSPENDED");
  });
});
