import {
  useMutation,
  type UseMutationResult,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { LeadPipelinePage } from '@/lib/types';
import { useToast } from './ui/toast';
import { findCachedLead } from './lead-board-utils';

export interface MoveInput {
  leadId: string;
  fromStageId: string;
  toStageId: string;
  lostReason?: string;
}

type LeadsData = InfiniteData<LeadPipelinePage>;
type Snapshot = Array<[readonly unknown[], LeadsData | undefined]>;

/** Moves the lead in every cached page: column queries and the list query. */
function applyOptimistic(qc: QueryClient, input: MoveInput): void {
  const lead = findCachedLead(qc, input.leadId);
  if (!lead || input.fromStageId === input.toStageId) return;
  const moved = {
    ...lead,
    pipelineStageId: input.toStageId,
    stageSetBy: 'OPERATOR' as const,
    suggestedStageId: null,
    suggestedReasonCodes: [],
    updatedAt: new Date().toISOString(),
  };
  for (const [key, data] of qc.getQueriesData<LeadsData>({
    queryKey: ['leads'],
  })) {
    if (!data) continue;
    if (key[1] === 'stage') {
      if (key[2] === input.fromStageId) {
        qc.setQueryData<LeadsData>(key, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== input.leadId),
          })),
        });
      } else if (key[2] === input.toStageId) {
        qc.setQueryData<LeadsData>(key, {
          ...data,
          pages: data.pages.map((page, index) =>
            index === 0 ? { ...page, items: [moved, ...page.items] } : page,
          ),
        });
      }
    } else if (key[1] === 'list') {
      qc.setQueryData<LeadsData>(key, {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) =>
            item.id === input.leadId ? moved : item,
          ),
        })),
      });
    }
  }
}

/** `PATCH /leads/:id/stage`, optimistic, rolled back when the API refuses. */
export function useLeadMove(): UseMutationResult<
  unknown,
  Error,
  MoveInput,
  { previous: Snapshot }
> {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (input: MoveInput) =>
      api(`/api/v1/leads/${input.leadId}/stage`, {
        method: 'PATCH',
        body:
          input.lostReason !== undefined
            ? { stageId: input.toStageId, lostReason: input.lostReason }
            : { stageId: input.toStageId },
      }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['leads'] });
      const previous: Snapshot = qc.getQueriesData<LeadsData>({
        queryKey: ['leads'],
      });
      applyOptimistic(qc, input);
      return { previous };
    },
    onError: (error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) {
        qc.setQueryData(key, data);
      }
      toast(t(errorKey(error)));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });
}
