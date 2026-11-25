"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import { api, errorKey, platformApi } from "@/lib/api";
import { LegalLinks } from "./legal-page";
import { LocaleSwitcher } from "./locale-switcher";
import { BrandLogo } from "./ui/brand";
import { Button } from "./ui/button";
import { fieldClass } from "./ui/fields";
import { Icon } from "./ui/icons";
import {
  MfaCodeForm,
  MfaEnrollForm,
  RecoveryCodes,
  type MfaSetup,
} from "./mfa";
import { PasswordInput } from "./ui/password-input";

type Panel = "app" | "console";
type Step = "password" | "choose" | "code" | "enroll" | "recovery";

interface SignInAnswer {
  panel: Panel | "choose";
  mfaRequired?: boolean;
  mfaEnrollmentRequired?: boolean;
  challenge?: string;
}

/**
 * One sign-in page (ADR 096): the account decides which panel opens. The
 * business panel and the console keep their own cookies and MFA routes.
 */
export function LoginForm(): ReactNode {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>("password");
  const [panel, setPanel] = useState<Panel>("app");
  const [challenge, setChallenge] = useState("");
  const [setup, setSetup] = useState<MfaSetup | undefined>();
  const [codes, setCodes] = useState<string[]>([]);

  function finish(opened: Panel): void {
    if (opened === "console") {
      queryClient.removeQueries({ queryKey: ["platform"] });
      router.replace("/console");
    } else router.replace("/today");
  }

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setBusy(false);
    }
  }

  const signIn = (chosen?: Panel): Promise<void> =>
    run(async () => {
      const result = await api<SignInAnswer>("/api/v1/auth/sign-in", {
        method: "POST",
        body: { email, password, ...(chosen ? { panel: chosen } : {}) },
      });
      if (result.panel === "choose") {
        setStep("choose");
        return;
      }
      setPanel(result.panel);
      if (result.challenge && result.mfaRequired) {
        setChallenge(result.challenge);
        setStep("code");
        return;
      }
      if (result.challenge && result.mfaEnrollmentRequired) {
        setChallenge(result.challenge);
        setSetup(
          await platformApi<MfaSetup>("/api/v1/platform/auth/login/mfa/setup", {
            method: "POST",
            body: { challenge: result.challenge },
          }),
        );
        setStep("enroll");
        return;
      }
      finish(result.panel);
    });

  function submit(event: FormEvent): void {
    event.preventDefault();
    void signIn();
  }

  const submitFactor = (
    factor: { code: string } | { recoveryCode: string },
  ): Promise<void> =>
    run(async () => {
      const body = { challenge, ...factor };
      if (panel === "console")
        await platformApi("/api/v1/platform/auth/login/mfa", {
          method: "POST",
          body,
        });
      else await api("/api/v1/auth/login/mfa", { method: "POST", body });
      finish(panel);
    });

  const enrol = (code: string): Promise<void> =>
    run(async () => {
      const done = await platformApi<{ recoveryCodes: string[] }>(
        "/api/v1/platform/auth/login/mfa/enable",
        { method: "POST", body: { challenge, code } },
      );
      setCodes(done.recoveryCodes);
      setStep("recovery");
    });

  const alert = error ? (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
    >
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      {t(error)}
    </p>
  ) : null;

  return (
    <main className="flex min-h-dvh flex-col bg-canvas lg:grid lg:grid-cols-[1.05fr_1fr]">
      <aside
        aria-hidden="true"
        className="hidden flex-col justify-between bg-linear-to-br from-[#0b2f8f] via-primary to-[#2d68f2] p-12 text-white lg:flex"
      >
        <BrandLogo name={t("app.brand")} inverse className="text-3xl" />
        <div className="flex max-w-md flex-col gap-8">
          <p className="text-4xl leading-tight font-semibold">
            {t("login.tagline")}
          </p>
          <ul className="flex flex-col gap-4">
            {["login.point1", "login.point2", "login.point3"].map((key) => (
              <li key={key} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/20">
                  <Icon name="check" className="h-4 w-4" />
                </span>
                <span className="text-base text-on-primary-muted">
                  {t(key)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-on-primary-muted">
          {t("login.taglineHint")}
        </p>
      </aside>

      <div className="flex flex-1 flex-col px-4 py-6 sm:px-8">
        <div className="flex justify-end">
          <LocaleSwitcher />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6">
          <div className="flex flex-col gap-2">
            <BrandLogo name={t("app.brand")} className="lg:hidden" />
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("login.title")}
            </h1>
            <p className="text-sm text-muted">{t("login.subtitle")}</p>
          </div>
          {step === "code" ? (
            <MfaCodeForm
              onSubmit={(factor) => void submitFactor(factor)}
              busy={busy}
              error={error}
            />
          ) : step === "enroll" && setup ? (
            <>
              <p role="status" className="text-sm text-muted">
                {t("mfa.console.required")}
              </p>
              <MfaEnrollForm
                setup={setup}
                busy={busy}
                error={error}
                onSubmit={(code) => void enrol(code)}
              />
            </>
          ) : step === "recovery" ? (
            <RecoveryCodes codes={codes} onDone={() => finish("console")} />
          ) : step === "choose" ? (
            <div
              data-testid="login-choose"
              className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card"
            >
              <p className="text-sm font-medium">{t("login.choose.title")}</p>
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void signIn("app")}
              >
                {t("login.choose.app")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void signIn("console")}
              >
                {t("login.choose.console")}
              </Button>
              {alert}
            </div>
          ) : (
            <form
              onSubmit={submit}
              className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
              noValidate
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t("login.email")}
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t("login.password")}
                <PasswordInput
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  className={fieldClass}
                />
              </label>
              {alert}
              <Button type="submit" variant="primary" loading={busy}>
                {busy ? t("login.submitting") : t("login.submit")}
              </Button>
            </form>
          )}
          {step === "password" ? (
            <p className="text-center text-sm">
              <Link
                href="/signup"
                data-testid="login-create-account"
                className="font-medium underline"
              >
                {t("signup.createAccount")}
              </Link>
            </p>
          ) : null}
          <LegalLinks />
        </div>
      </div>
    </main>
  );
}
