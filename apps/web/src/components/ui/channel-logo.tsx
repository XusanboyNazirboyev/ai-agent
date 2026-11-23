import { useId, type ReactNode } from 'react';
import { channelName } from '@/lib/channel-names';

/**
 * Small messenger marks (owner 2026-11-23: the inbox tells Telegram and
 * Instagram chats apart at a glance). Simplified shapes, brand colours.
 */
export function ChannelLogo(props: {
  channelType: string;
  className?: string;
  /** Decorative next to a written name; labelled when it stands alone. */
  decorative?: boolean;
}): ReactNode {
  const gradient = useId();
  const label = props.decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': channelName(props.channelType) };
  const className = props.className ?? 'h-4 w-4';
  if (props.channelType === 'instagram')
    return (
      <svg viewBox="0 0 24 24" className={className} {...label}>
        <defs>
          <linearGradient id={gradient} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#F58529" />
            <stop offset="0.5" stopColor="#DD2A7B" />
            <stop offset="1" stopColor="#515BD4" />
          </linearGradient>
        </defs>
        <rect width="24" height="24" rx="6.5" fill={`url(#${gradient})`} />
        <rect
          x="5.5"
          y="5.5"
          width="13"
          height="13"
          rx="4"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
        />
        <circle
          cx="12"
          cy="12"
          r="3.1"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
        />
        <circle cx="16.2" cy="7.8" r="1" fill="#fff" />
      </svg>
    );
  if (props.channelType === 'facebook')
    return (
      <svg viewBox="0 0 24 24" className={className} {...label}>
        <circle cx="12" cy="12" r="12" fill="#0084FF" />
        <path
          d="M5.5 14.5 10 9.8l2.4 2.4 4.1-2.4-4.5 4.8-2.4-2.4z"
          fill="#fff"
        />
      </svg>
    );
  if (props.channelType === 'telegram')
    return (
      <svg viewBox="0 0 24 24" className={className} {...label}>
        <circle cx="12" cy="12" r="12" fill="#2AABEE" />
        <path
          d="M5.4 11.7 17.2 7.2c.55-.2 1.03.13.85.96l-2 9.45c-.15.67-.55.83-1.1.52l-3.05-2.25-1.47 1.42c-.16.16-.3.3-.62.3l.22-3.1 5.65-5.1c.25-.22-.05-.34-.38-.12l-6.98 4.4-3-.94c-.66-.2-.67-.65.13-.96z"
          fill="#fff"
        />
      </svg>
    );
  return null;
}
