import type { ReactNode } from 'react';
import { BrandMark } from './brand';

/** Full-page notice (not found, unexpected error) in the product's style. */
export function StatusScreen(props: {
  code: string;
  title: string;
  body: string;
  children: ReactNode;
}): ReactNode {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
        <BrandMark className="h-10 w-11" />
        <p className="text-5xl font-extrabold tracking-tight text-brand">
          {props.code}
        </p>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold">{props.title}</h1>
          <p className="text-sm text-muted">{props.body}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {props.children}
        </div>
      </div>
    </main>
  );
}
