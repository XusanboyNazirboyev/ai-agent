'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { useToast } from './ui/toast';

/** Refreshes everything that shows leads after an archive change (ADR 062). */
export function useRefreshLeads(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['board'] });
    void qc.invalidateQueries({ queryKey: ['pipelines'] });
  };
}

/**
 * "Archive" in the lead panel (OWNER, ADMIN). The lead leaves the board and
 * the list at once and can be restored from the Archive view.
 */
export function LeadArchiveButton(props: {
  leadId: string;
  onArchived: () => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefreshLeads();
  const [confirming, setConfirming] = useState(false);
  const archive = useMutation({
    mutationFn: () =>
      api(`/api/v1/leads/${props.leadId}/archive`, { method: 'POST' }),
    onSuccess: () => {
      setConfirming(false);
      toast(t('toast.leadArchived'));
      refresh();
      props.onArchived();
    },
    onError: (e: unknown) => {
      setConfirming(false);
      toast(t(errorKey(e)));
    },
  });
  return (
    <>
      <div>
        <Button
          size="sm"
          variant="secondary"
          icon="trash"
          data-testid="lead-archive"
          onClick={() => setConfirming(true)}
        >
          {t('leads.archive')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t('leads.archive.title')}
        body={t('leads.archive.body')}
        confirmLabel={t('leads.archive')}
        cancelLabel={t('app.cancel')}
        busy={archive.isPending}
        onConfirm={() => archive.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
