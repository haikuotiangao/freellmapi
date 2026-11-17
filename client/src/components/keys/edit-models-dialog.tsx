import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { formatContext, type FallbackEntry } from '@/lib/routing'
import { scopeCandidates } from '@/lib/model-scope-selection'
import { X } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'

/** Re-open the post-add model picker for an existing key. The provider's LIVE
 *  /models is the source of truth: a model the provider retired (e.g. NVIDIA
 *  dropping DeepSeek) must disappear from the picker even if the signed
 *  catalog's monthly snapshot still lists it. If the live fetch fails, the
 *  signed catalog is kept as a fallback so the operator is never locked out. */
interface LiveDiscoveredModel {
  id: string
  priceNote?: string
  isFree?: boolean
  contextWindow?: number
  vision?: boolean
  kind?: string
}
interface LivePreview {
  models: LiveDiscoveredModel[]
  total: number
}

interface Candidate {
  modelId: string
  displayName: string
  sizeLabel: string | null
  contextWindow: number | null
  priceNote?: string
  isFree?: boolean
}

export function EditModelsDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Static catalog: the fallback when the live fetch fails, and the source for
  // built-in providers catalog-sync owns display metadata for.
  const { data: catalog = [] } = useQuery<Pick<FallbackEntry, 'platform' | 'modelId' | 'displayName' | 'sizeLabel' | 'contextWindow'>[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })

  // Live list from the provider itself, read-only. The dialog is mounted only
  // while open, so this fires on open and needs no reset effect.
  const live = useQuery<LivePreview>({
    queryKey: ['key-preview-models', apiKey.id],
    queryFn: () => apiFetch('/api/keys/preview-models', {
      method: 'POST',
      body: JSON.stringify({ keyId: apiKey.id }),
    }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  })

  const catalogCandidates: Candidate[] = apiKey.platform === 'custom'
    ? (apiKey.models ?? [])
      .filter(model => model.kind === 'chat')
      .map(model => ({
        modelId: model.modelId,
        displayName: model.displayName || model.modelId,
        sizeLabel: null,
        contextWindow: null,
      }))
    : scopeCandidates(catalog, apiKey.platform).map(model => ({
        modelId: model.modelId,
        displayName: model.displayName,
        sizeLabel: model.sizeLabel,
        contextWindow: model.contextWindow,
      }))

  // Live wins when it answered with a non-empty list. An empty live list means
  // "provider currently serves nothing" — rare, and refusing to fall back
  // would blank the picker, so treat it like a failure and keep the catalog.
  const liveModels = live.data?.models ?? []
  const useLive = !live.isPending && !live.isError && liveModels.length > 0
  const candidates: Candidate[] = useLive
    ? liveModels.map(m => ({
        modelId: m.id,
        displayName: m.id,
        sizeLabel: null,
        contextWindow: m.contextWindow ?? null,
        priceNote: m.priceNote,
        isFree: m.isFree,
      }))
    : catalogCandidates

  const allIds = candidates.map(m => m.modelId)
  // Keep "all" as a mode rather than snapshotting every current id: the list
  // (catalog or live) resolves after mount, and a stored full list would go stale.
  const [allMode, setAllMode] = useState(apiKey.modelScope === null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(apiKey.modelScope ?? []))

  const syncCatalog = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch('/api/premium/sync', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['key-preview-models', apiKey.id] })
      toast.success(t('keys.editModelsSynced'))
    },
    onError: error => toast.error((error as Error).message),
  })

  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (modelScope: string[] | null) =>
      apiFetch(`/api/keys/${apiKey.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ modelScope }),
      }),
    onSuccess: (_data, modelScope) => {
      // The scope changed: refetch the dashboard chain so the models page shows
      // exactly what is now enabled, without a manual reload (#user request 2).
      for (const key of ['keys', 'fallback', 'models']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      toast.success(t(
        modelScope === null
          ? 'keys.modelPicker.allSaved'
          : modelScope.length === 1
            ? 'keys.modelPicker.scopedOne'
            : 'keys.modelPicker.scopedOther',
        ...(modelScope === null ? [] : [{ count: modelScope.length }]),
      ))
      onOpenChange(false)
    },
  })

  const toggle = (id: string) => {
    if (allMode) {
      setAllMode(false)
      const next = new Set(allIds)
      next.delete(id)
      setSelected(next)
      return
    }
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isSelected = (id: string) => allMode || selected.has(id)
  const allSelected = allIds.length > 0 && allIds.every(isSelected)
  const selectedCount = allMode ? allIds.length : selected.size
  const toggleAll = () => {
    setAllMode(false)
    setSelected(allSelected ? new Set() : new Set(allIds))
  }
  const submit = () => save.mutate(allSelected ? null : [...selected])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.editModels')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {apiKey.platform === 'custom' ? (
          <p className="text-xs text-muted-foreground">{t('keys.editModelsCustomHint')}</p>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <p className="max-w-prose text-xs text-muted-foreground">{t('keys.editModelsHint')}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => syncCatalog.mutate()}
              disabled={syncCatalog.isPending}
            >
              {syncCatalog.isPending ? t('keys.editModelsSyncing') : t('keys.editModelsSync')}
            </Button>
          </div>
        )}

        {/* Live-fetch state: a thin strip tells the operator which source they
            are looking at, and a failed fetch keeps the catalog + shows why. */}
        {live.isPending && (
          <p className="mt-3 text-xs text-muted-foreground">{t('keys.editModelsLiveLoading')}</p>
        )}
        {useLive && (
          <p className="mt-3 text-xs text-muted-foreground">{t('keys.editModelsLiveHint')}</p>
        )}
        {live.isError && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400" title={(live.error as Error).message}>
            {t('keys.editModelsLiveFailed')}
          </p>
        )}

        {!useLive && catalog.length === 0 && (
          <p className="mt-4 text-xs text-muted-foreground">{t('common.loading')}</p>
        )}

        {candidates.length > 0 && (
          <>
            <label className="mt-4 flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="size-4 accent-primary"
              />
              <span>{t('keys.discoverSelectAll')}</span>
              <span className="ml-auto font-normal text-muted-foreground tabular-nums">
                {t('keys.modelPicker.count', { selected: selectedCount, total: allIds.length })}
              </span>
            </label>

            <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-2xl border divide-y">
              {candidates.map(model => (
                <label
                  key={model.modelId}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={isSelected(model.modelId)}
                    onChange={() => toggle(model.modelId)}
                    className="size-4 accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate" title={model.modelId}>
                    {model.displayName}
                  </span>
                  {/* Live price badge — advisory only, never auto-unchecks a
                      model the operator had already chosen. */}
                  {model.priceNote && (
                    <span
                      className={`shrink-0 max-w-[140px] truncate rounded-full px-1.5 py-0.5 text-[10px] ${
                        model.isFree
                          ? 'bg-emerald-600/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-400'
                          : 'bg-muted text-muted-foreground'
                      }`}
                      title={model.priceNote}
                    >
                      {model.priceNote}
                    </span>
                  )}
                  {model.sizeLabel && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {model.sizeLabel}
                    </span>
                  )}
                  {model.contextWindow != null && model.contextWindow > 0 && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                      {t('models.ctxBadge', { size: formatContext(model.contextWindow) })}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </>
        )}

        {save.isError && (
          <p className="mt-3 text-xs text-destructive">{(save.error as Error).message}</p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={(!allMode && selected.size === 0) || save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
