/**
 * What the stage sync (ADR 079, generalised by ADR 081) needs from a CRM
 * connector: its lead stages, and the leads changed since a time. One scan
 * works with any connector that implements this.
 */
export type StageSemantics = 'process' | 'success' | 'failure' | 'apology';

export interface PortalStage {
  readonly id: string;
  readonly name: string;
  readonly sort: number;
  readonly semantics: StageSemantics;
}

export interface SyncLeadChange {
  /** The CRM's lead id, as stored in `connector_operations.external_id`. */
  readonly externalId: string;
  readonly stageId: string;
  readonly updatedAt: Date;
}

export interface StageSyncSource {
  /** Start of the LOST reason text, e.g. "Bitrix24". */
  readonly stageSyncLabel: string;
  /** Rows per page; a shorter page ends the scan. */
  readonly stageSyncPageSize: number;
  listStages(): Promise<PortalStage[]>;
  /** One page (0-based), oldest change first, of leads changed since `since`. */
  listChangedLeads(since: Date, page: number): Promise<SyncLeadChange[]>;
}

export function isStageSyncSource(value: unknown): value is StageSyncSource {
  const v = value as Partial<StageSyncSource> | null;
  return (
    !!v &&
    typeof v.listStages === 'function' &&
    typeof v.listChangedLeads === 'function' &&
    typeof v.stageSyncLabel === 'string' &&
    typeof v.stageSyncPageSize === 'number'
  );
}
