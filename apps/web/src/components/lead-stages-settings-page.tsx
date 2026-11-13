"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import { api, errorKey } from "@/lib/api";
import type { LeadStage } from "@/lib/types";
import { useShell } from "./app-shell";
import { SettingsSubPage } from "./settings-section-nav";
import { Button } from "./ui/button";
import { fieldClass } from "./ui/fields";
import { Icon } from "./ui/icons";
import { SkeletonRows } from "./ui/skeleton";
import { useToast } from "./ui/toast";

function labelFor(
  stage: LeadStage,
  translate: (key: string) => string,
): string {
  return (
    stage.name ?? (stage.code ? translate(`leads.stage.${stage.code}`) : "")
  );
}

export function LeadStagesSettingsPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const canEdit = operator.role === "OWNER" || operator.role === "ADMIN";
  const query = useQuery({
    queryKey: ["lead-stages"],
    queryFn: () => api<LeadStage[]>("/api/v1/leads/stages"),
  });

  useEffect(() => {
    if (query.data)
      setNames(
        Object.fromEntries(
          query.data.map((stage) => [stage.id, labelFor(stage, t)]),
        ),
      );
  }, [query.data, t]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["lead-stages"] });
    void queryClient.invalidateQueries({ queryKey: ["leads"] });
  };
  const create = useMutation({
    mutationFn: (name: string) =>
      api<LeadStage>("/api/v1/leads/stages", {
        method: "POST",
        body: { name },
      }),
    onSuccess: () => {
      setNewName("");
      toast(t("toast.leadStageAdded"));
      refresh();
    },
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api<LeadStage>(`/api/v1/leads/stages/${input.id}`, {
        method: "PATCH",
        body: { name: input.name },
      }),
    onSuccess: () => {
      toast(t("toast.leadStageSaved"));
      refresh();
    },
  });

  function add(event: FormEvent): void {
    event.preventDefault();
    const value = newName.trim();
    if (value && !create.isPending) create.mutate(value);
  }

  const failure = create.error ?? rename.error;
  return (
    <SettingsSubPage active="pipeline">
      <div
        role="region"
        tabIndex={0}
        aria-label={t("settings.section.pipeline")}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 sm:p-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">{t("leadStages.title")}</h2>
            <p className="text-sm text-muted">{t("leadStages.intro")}</p>
          </div>
          {!canEdit ? (
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted">
              <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
              {t("settings.readOnly")}
            </p>
          ) : null}
          {failure ? (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
            >
              <Icon name="alert" />
              {t(errorKey(failure))}
            </p>
          ) : null}
          {query.isPending ? (
            <div role="status">
              <span className="sr-only">{t("app.loading")}</span>
              <SkeletonRows rows={4} />
            </div>
          ) : null}
          {query.isError ? (
            <div className="flex flex-col items-start gap-3">
              <p role="alert" className="text-sm text-danger-fg">
                {t(errorKey(query.error))}
              </p>
              <Button size="sm" onClick={() => void query.refetch()}>
                {t("app.retry")}
              </Button>
            </div>
          ) : null}
          {query.data ? (
            <ul className="flex flex-col gap-2">
              {query.data.map((stage) => {
                const current = labelFor(stage, t);
                const value = names[stage.id] ?? current;
                return (
                  <li
                    key={stage.id}
                    className="flex min-w-0 flex-wrap items-end gap-2 rounded-2xl border border-line bg-surface p-3 shadow-card sm:p-4"
                  >
                    <label className="flex min-w-0 flex-1 basis-52 flex-col gap-1 text-sm font-medium">
                      {t("leadStages.stageName")}
                      <input
                        value={value}
                        maxLength={80}
                        disabled={!canEdit || rename.isPending}
                        onChange={(event) =>
                          setNames((previous) => ({
                            ...previous,
                            [stage.id]: event.target.value,
                          }))
                        }
                        className={fieldClass}
                      />
                    </label>
                    <Button
                      size="sm"
                      loading={
                        rename.isPending && rename.variables?.id === stage.id
                      }
                      disabled={
                        !canEdit ||
                        rename.isPending ||
                        value.trim().length === 0 ||
                        value.trim() === current
                      }
                      onClick={() =>
                        rename.mutate({ id: stage.id, name: value.trim() })
                      }
                    >
                      {t("app.save")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {canEdit ? (
            <form
              onSubmit={add}
              className="flex min-w-0 flex-wrap items-end gap-2 rounded-2xl border border-dashed border-line p-3 sm:p-4"
            >
              <label className="flex min-w-0 flex-1 basis-52 flex-col gap-1 text-sm font-medium">
                {t("leadStages.newStage")}
                <input
                  value={newName}
                  maxLength={80}
                  onChange={(event) => setNewName(event.target.value)}
                  className={fieldClass}
                />
              </label>
              <Button
                type="submit"
                variant="primary"
                icon="plus"
                loading={create.isPending}
                disabled={!newName.trim() || create.isPending}
              >
                {t("leadStages.add")}
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </SettingsSubPage>
  );
}
