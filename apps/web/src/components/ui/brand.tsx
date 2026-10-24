import type { ReactNode } from 'react';

/**
 * tezda mark: a speech bubble with a "t" that ends in an arrow, and speed
 * lines. Drawn from the supplied logo as an inline SVG approximation; replace
 * the shapes with the official artwork here and every screen follows.
 * `inverse` is for use on a brand-coloured background.
 */
export function BrandMark(props: {
  className?: string;
  inverse?: boolean;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 74 60"
      aria-hidden="true"
      focusable="false"
      className={`${props.className ?? 'h-9 w-10'} ${props.inverse ? 'text-white' : 'text-primary'}`}
    >
      <g className="fill-current">
        <rect x="2" y="13" width="12" height="4.6" rx="2.3" opacity="0.5" />
        <rect x="0" y="23.4" width="16" height="4.6" rx="2.3" opacity="0.32" />
        <rect x="4" y="33.8" width="11" height="4.6" rx="2.3" opacity="0.5" />
        <rect x="18" y="4" width="52" height="44" rx="14" />
        <path d="M22 41 L17 58 L38 46 Z" />
      </g>
      <g
        fill="none"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={props.inverse ? 'stroke-primary' : 'stroke-white'}
      >
        <path d="M40 14 V29.5 a5 5 0 0 0 5 5 h1.5" />
        <path d="M31.5 21.5 H52" />
        <path d="M47.5 16 L53 21.5 L47.5 27" />
      </g>
    </svg>
  );
}

/** Mark plus the italic wordmark; the name comes from the catalog. */
export function BrandLogo(props: {
  name: string;
  inverse?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span className={`inline-flex items-center gap-2 ${props.className ?? ''}`}>
      <BrandMark inverse={props.inverse} />
      <span
        className={`text-2xl font-extrabold tracking-tight italic ${props.inverse ? 'text-white' : 'text-brand'}`}
      >
        {props.name}
      </span>
    </span>
  );
}
