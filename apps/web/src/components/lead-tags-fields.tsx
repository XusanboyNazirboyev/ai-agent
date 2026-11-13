"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import { api, errorKey } from "@/lib/api";
import type {
  CustomFieldEntry,
  CustomFieldType,
  CustomFieldValue,
  Role,
  Tag,
  TagRef,
} from "@/lib/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { fieldClass } from "./ui/fields";
import { Icon } from "./ui/icons";
import { useToast } from "./ui/toast";

function canEdit(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "OPERATOR";
}

export function LeadTagsEditor(props: {
  leadId: string;
  tags: TagRef[];
  role: Role;
}): ReactNode {
  const { leadId, role } = props;
  const tags = props.tags ?? [];
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = canEdit(role);
  const [open, setOpen] = useState(false);

  const allTags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ items: Tag[] }>("/api/v1/tags"),
    enabled: open && editable,
  });
  const save = useMutation({
    mutationFn: (tagIds: string[]) =>
      api(`/api/v1/leads/${leadId}/tags`, { method: "PUT", body: { tagIds } }),
    onSuccess: () => {
      toast(t("toast.tagsSaved"));
      void qc.invalidateQueries({ queryKey: ["conversation"] });
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["person"] });
    },
  });
  const available = (allTags.data?.items ?? []).filter(
    (tag) => !tags.some((t) => t.id === tag.id),
  );

  function remove(tag: TagRef): void {
    save.mutate(tags.filter((x) => x.id !== tag.id).map((x) => x.id));
  }
  function add(tagId: string): void {
    if (!tagId) return;
    save.mutate([...tags.map((x) => x.id), tagId]);
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="lead-tags">
      <span className="text-xs font-medium text-muted">{t("leads.tags")}</span>
      <div className="flex flex-wrap items-center gap-2">
        {tags.length === 0 ? (
          <span className="text-xs text-muted">{t("leads.noTags")}</span>
        ) : null}
        {tags.map((tag) => (
          <span
            key={tag.id}
            data-testid="lead-tag-chip"
            className="inline-flex items-center gap-1"
          >
            <Badge>{tag.name}</Badge>
            {editable ? (
              <button
                type="button"
                aria-label={t("leads.removeTag", { name: tag.name })}
                data-testid="lead-tag-remove"
                disabled={save.isPending}
                onClick={() => remove(tag)}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              >
                <Icon name="x" className="h-3 w-3" />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          {open ? (
            <>
              <select
                aria-label={t("leads.addTag")}
                data-testid="lead-tag-select"
                defaultValue=""
                onChange={(e) => add(e.target.value)}
                className={`${fieldClass} max-w-xs`}
              >
                <option value="">{t("leads.addTag")}</option>
                {available.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => setOpen(false)}>
                {t("confirm.cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              icon="plus"
              onClick={() => setOpen(true)}
              data-testid="lead-tag-add"
              disabled={save.isPending}
            >
              {t("leads.addTag")}
            </Button>
          )}
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(save.error))}
        </p>
      ) : null}
    </div>
  );
}

export function LeadCustomFieldsEditor(props: {
  leadId: string;
  fields: CustomFieldEntry[];
  role: Role;
}): ReactNode {
  const { leadId, role } = props;
  const fields = props.fields ?? [];
  const { t } = useI18n();
  const editable = canEdit(role);
  if (fields.length === 0) {
    return (
      <div data-testid="lead-custom-fields" className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">
          {t("leads.customFields")}
        </span>
        <span className="text-xs text-muted">{t("leads.noCustomFields")}</span>
      </div>
    );
  }
  return (
    <div data-testid="lead-custom-fields" className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted">
        {t("leads.customFields")}
      </span>
      <ul className="flex flex-col gap-2">
        {fields.map((field) => (
          <LeadFieldRow
            key={field.key}
            leadId={leadId}
            field={field}
            editable={editable}
          />
        ))}
      </ul>
    </div>
  );
}

function LeadFieldRow(props: {
  leadId: string;
  field: CustomFieldEntry;
  editable: boolean;
}): ReactNode {
  const { leadId, field, editable } = props;
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>(() =>
    toDraft(field.type, field.value),
  );
  const [touched, setTouched] = useState(false);
  const value = touched ? draft : toDraft(field.type, field.value);
  const save = useMutation({
    mutationFn: (next: CustomFieldValue) =>
      api(`/api/v1/leads/${leadId}/custom-fields`, {
        method: "PATCH",
        body: { values: { [field.key]: next } },
      }),
    onSuccess: () => {
      setTouched(false);
      toast(t("toast.fieldSaved"));
      void qc.invalidateQueries({ queryKey: ["conversation"] });
      void qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });

  return (
    <li
      data-testid="lead-custom-field"
      data-field-key={field.key}
      className="flex min-w-0 flex-col gap-1"
    >
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-32 flex-col gap-1 text-xs text-muted">
          {field.label}
          <FieldEditor
            type={field.type}
            value={value}
            disabled={!editable || save.isPending}
            label={field.label}
            onChange={(v) => {
              setTouched(true);
              setDraft(v);
            }}
          />
        </label>
        {editable ? (
          <Button
            size="sm"
            onClick={() => save.mutate(fromDraft(field.type, value))}
            loading={save.isPending}
            disabled={save.isPending}
            data-testid="lead-field-save"
          >
            {t("leads.fieldSave")}
          </Button>
        ) : null}
      </div>
      {save.isError ? (
        <p role="alert" className="text-xs text-danger-fg">
          {t(errorKey(save.error))}
        </p>
      ) : null}
    </li>
  );
}

function FieldEditor(props: {
  type: CustomFieldType;
  value: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
}): ReactNode {
  const { type, value, disabled, label, onChange } = props;
  if (type === "BOOLEAN")
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === "true"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        className="h-5 w-5 accent-primary-fg"
      />
    );
  if (type === "NUMBER")
    return (
      <input
        type="number"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  if (type === "DATE")
    return (
      <input
        type="date"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  return (
    <input
      type="text"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    />
  );
}
function toDraft(type: CustomFieldType, value: CustomFieldValue): string {
  if (value === null || value === undefined)
    return type === "BOOLEAN" ? "false" : "";
  if (type === "BOOLEAN") return value ? "true" : "false";
  return String(value);
}
function fromDraft(type: CustomFieldType, draft: string): CustomFieldValue {
  if (type === "BOOLEAN") return draft === "true";
  if (draft === "") return null;
  if (type === "NUMBER") {
    const n = Number(draft);
    return Number.isFinite(n) ? n : null;
  }
  return draft;
}
