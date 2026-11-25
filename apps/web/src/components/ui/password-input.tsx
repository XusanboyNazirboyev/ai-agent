'use client';

import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { fieldClass } from './fields';
import { Icon } from './icons';

/**
 * A password field with a show/hide button (owner 2026-11-25). Hidden by
 * default; the button never submits the form and says what it will do.
 */
export function PasswordInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>,
): ReactNode {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const { className, ...rest } = props;
  return (
    <span className="relative flex">
      <input
        {...rest}
        type={shown ? 'text' : 'password'}
        className={`${className ?? fieldClass} pe-11`}
      />
      <button
        type="button"
        data-testid="password-toggle"
        aria-pressed={shown}
        disabled={rest.disabled}
        onClick={() => setShown((value) => !value)}
        className="absolute inset-y-0 end-0 grid w-11 place-items-center rounded-e-lg text-muted hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:opacity-60"
      >
        {/* Named by text, not aria-label, so the field's own label stays the
            only label that matches "Password". */}
        <span className="sr-only">
          {t(shown ? 'password.hide' : 'password.show')}
        </span>
        <Icon name={shown ? 'eyeOff' : 'eye'} className="h-5 w-5" />
      </button>
    </span>
  );
}
