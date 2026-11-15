'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

interface TemplateView {
  available: boolean;
  key?: string;
  pipelineName?: string;
  pipelineExists?: boolean;
  stages?: Array<{ code: string; kind: 'OPEN' | 'WON' | 'LOST' }>;
  leadFields?: Array<{
    key: string;
    type: string;
    label: string;
    exists: boolean;
  }>;
  tags?: Array<{ name: string; color: string | null; exists: boolean }>;
}

const KIND_TONE: Record<string, Tone> = {
  OPEN: 'neutral',
  WON: 'success',
  LOST: 'danger',
};

/**
 * The ready template of the workspace's kind of business (step 7): stages,
 * lead fields and tags, shown first, applied only when the admin asks. Hidden
 * once its pipeline exists, and for a business without a template.
 */
export function CrmTemplateCard(): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [makeDefault, setMakeDefault] = useState(true);
  const view = useQuery({
    queryKey: ['crm-template'],
    queryFn: () => api<TemplateView>('/api/v1/crm-template'),
  });
  const apply = useMutation({
    mutationFn: () =>
      api<{ created: { pipeline: boolean; fields: number; tags: number } }>(
        '/api/v1/crm-template/apply',
        { method: 'POST', body: { makeDefault } },
      ),
    onSuccess: () => {
      toast(t('template.applied'));
      for (const key of [
        'crm-template',
        'pipelines',
        'lead-stages',
        'leads',
        'tags',
        'custom-fields',
      ])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const data = view.data;
  if (!data?.available || data.pipelineExists) return null;
  const newFields = (data.leadFields ?? []).filter((f) => !f.exists);
  const newTags = (data.tags ?? []).filter((tag) => !tag.exists);

  return (
    <section
      data-testid="crm-template"
      aria-labelledby="crm-template-title"
      className="flex flex-col gap-3 rounded-2xl border border-primary/40 bg-primary-soft p-4"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface text-primary-fg">
          <Icon name="target" className="h-5 w-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id="crm-template-title" className="font-semibold">
            {t('template.title', { name: data.pipelineName ?? '' })}
          </h3>
          <p className="text-sm text-muted">{t('template.intro')}</p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted">{t('template.stages')}</p>
        <ol
          className="flex flex-wrap items-center gap-1.5"
          data-testid="crm-template-stages"
        >
          {(data.stages ?? []).map((stage, index) => (
            <li key={stage.code} className="flex items-center gap-1.5">
              {index > 0 && stage.kind === 'OPEN' ? (
                <Icon name="chevronRight" className="h-3.5 w-3.5 text-muted" />
              ) : null}
              <Badge tone={KIND_TONE[stage.kind]}>
                {t(`leads.stage.${stage.code}`)}
              </Badge>
            </li>
          ))}
        </ol>
      </div>
      {newFields.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted">
            {t('template.fields')}
          </p>
          <p className="text-sm">{newFields.map((f) => f.label).join(' · ')}</p>
        </div>
      ) : null}
      {newTags.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted">{t('template.tags')}</p>
          <span className="flex flex-wrap gap-1.5">
            {newTags.map((tag) => (
              <Badge key={tag.name}>{tag.name}</Badge>
            ))}
          </span>
        </div>
      ) : null}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={makeDefault}
          onChange={(event) => setMakeDefault(event.target.checked)}
          data-testid="crm-template-default"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        />
        <span className="flex flex-col">
          <span className="font-medium">{t('template.makeDefault')}</span>
          <span className="text-xs text-muted">
            {t('template.makeDefaultHint')}
          </span>
        </span>
      </label>
      {apply.isError ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t(errorKey(apply.error))}
        </p>
      ) : null}
      <div>
        <Button
          variant="primary"
          icon="check"
          loading={apply.isPending}
          data-testid="crm-template-apply"
          onClick={() => apply.mutate()}
        >
          {t('template.apply')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('template.safe')}</p>
    </section>
  );
}
