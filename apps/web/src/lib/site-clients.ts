/**
 * Owner 2026-11-24: businesses that use tezda, shown on the sales page as
 * social proof. Real clients only, each with their consent; the logo file
 * goes in `public/clients/`. The strip stays hidden while this is empty.
 */
export interface SiteClient {
  name: string;
  /** Path under `public/`, e.g. `/clients/name.svg`. */
  logo: string;
}

export const SITE_CLIENTS: readonly SiteClient[] = [];
