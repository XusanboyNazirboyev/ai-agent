'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

export interface BusinessProfile {
  name: string;
  address: string;
  phone: string;
  hours: string;
  website: string;
}

const FIELDS = ['name', 'address', 'phone', 'hours', 'website'] as const;
const EMPTY: BusinessProfile = {
  name: '',
  address: '',
  phone: '',
  hours: '',
  website: '',
};

/**
 * Owner 2026-11-23: the only place the bot learns the business's own name,
 * address, phone, hours and website. What is empty here the bot never says;
 * it hands such a question to an operator.
 */
export function BusinessProfileCard({
  canChange,
}: {
  canChange: boolean;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api<BusinessProfile>('/api/v1/business-profile'),
  });
  const [form, setForm] = useState<BusinessProfile>(EMPTY);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);
  const save = useMutation({
    mutationFn: (body: BusinessProfile) =>
      api<BusinessProfile>('/api/v1/business-profile', {
        method: 'PUT',
        body,
      }),
    onSuccess: (saved) => {
      toast(t('profile.saved'));
      queryClient.setQueryData(['business-profile'], saved);
      void queryClient.invalidateQueries({ queryKey: ['go-live'] });
    },
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    save.mutate(form);
  }
  return (
    <section
      id="business-profile"
      data-testid="business-profile"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">{t('profile.title')}</h2>
        <p className="text-sm text-muted">{t('profile.intro')}</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {FIELDS.map((field) => (
          <label
            key={field}
            className="flex flex-col gap-1.5 text-sm font-medium"
          >
            {t(`profile.field.${field}`)}
            <input
              name={field}
              value={form[field]}
              disabled={!canChange || query.isLoading}
              maxLength={field === 'name' ? 200 : 300}
              inputMode={field === 'phone' ? 'tel' : undefined}
              placeholder={t(`profile.hint.${field}`)}
              data-testid={`profile-${field}`}
              className={fieldClass}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })}
            />
          </label>
        ))}
        {save.isError ? (
          <p
            role="alert"
            data-testid="profile-error"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(save.error))}
          </p>
        ) : null}
        {canChange ? (
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            data-testid="profile-save"
            className="self-start"
          >
            {t('profile.save')}
          </Button>
        ) : (
          <p className="text-sm text-muted">{t('bot.readOnly')}</p>
        )}
      </form>
    </section>
  );
}
