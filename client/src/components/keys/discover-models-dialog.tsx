import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { formatContext } from '@/lib/routing'

// #488: relays add and drop models weekly, so keeping a custom endpoint's model
// list current by hand means re-running `curl .../v1/models | jq` every so
// often. Ask the endpoint instead, tick the ones to keep, register them in one
// call. Reads only the user's OWN endpoint with the user's OWN key.
//
// #1348: the same dialog serves built-in provider keys whose platform the
// catalog carries no models for. The list comes from that provider's own
// /models, picks register as discovered rows, and only chat models can be
// picked (the catalog owns media and embedding rows for built-in platforms).

export interface DiscoveredModel {
  id: string
  ownedBy: string | null
  registered: boolean
  /** Whether this model is in THIS key's saved scope — the authoritative tick
   *  state for "which models this key serves". */
  inScope?: boolean
  /** Nightly automated-test success rate (0..1), null if never tested. */
  testSuccessRate?: number | null
  /** Retired after 5 straight failed nightly tests; still force-addable. */
  testUnavailable?: boolean
  /** Approximate context window in tokens when the upstream advertises one. */
  contextWindow?: number
  /** Human-readable price hint ("free", "$1.25/M in $2/M out") when present (#685). */
  priceNote?: string
  /** The server's verdict on whether the note means free — the only thing this
   *  picker badges green, so "$10/M in" can never read as free. */
  isFree?: boolean
  /** True when the upstream advertises image input. */
  vision?: boolean
  /** Present only when the model is discernibly NOT a chat model (#1051). The
   *  server routes it to the matching table on register; video is skipped. */
  kind?: 'embedding' | 'image' | 'audio' | 'transcription' | 'video'
}

interface DiscoverResponse {
  baseUrl: string
  keyId: number | null
  models: DiscoveredModel[]
  total: number
  registeredCount: number
}

/** How the endpoint is named to the server: a saved key row, or a base URL the
 *  user is still typing (with the key they typed alongside it). */
export interface EndpointRef {
  keyId?: number
  baseUrl?: string
  apiKey?: string
  /** Group to file a NEW endpoint under on register (#1176); blank leaves it. */
  groupLabel?: string
}

export function DiscoverModelsDialog({
  open,
  onOpenChange,
  endpoint,
  onRegistered,
  builtin = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  endpoint: EndpointRef
  onRegistered?: () => void
  /** A built-in provider key rather than a custom endpoint (#1348). */
  builtin?: boolean
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // The ids the user ticked = the COMPLETE model range this key should serve.
  // It is initialised from each model's `inScope` (the saved scope) on first
  // load, and saved back as the whole scope on submit — so "picked in discover"
  // == "shown in the editor" == "listed on the dashboard".
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const initializedRef = useRef(false)
  // Text filter over the model id. Typing "free" narrows to ids containing
  // that substring — the operator's fastest way to sweep a relay's catalog
  // for free-tier models without scrolling hundreds of rows.
  const [filter, setFilter] = useState('')

  // A query, not a mutation: the dialog is mounted only while open, so the
  // fetch fires on mount and the component needs no reset effect.
  //
  // The cache is KEPT (no `gcTime: 0`): dropping it the moment the dialog
  // closed made every re-open start from an empty list, so the models
  // "flashed" (the previous rows) and were gone. With the cache, a re-open
  // shows the last list at once while the fresh one loads on top of it.
  const discover = useQuery<DiscoverResponse>({
    queryKey: ['custom-endpoint-models', builtin, endpoint.keyId ?? null, endpoint.baseUrl ?? null],
    queryFn: () => apiFetch('/api/keys/custom/discover-models', {
      method: 'POST',
      body: JSON.stringify({ keyId: endpoint.keyId, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey }),
    }),
    retry: false,
    staleTime: 0,
  })
  // The last list that loaded successfully. A failed refetch must not blank
  // the picker: the operator would watch the models they just ticked (and the
  // "already added" markers) disappear for no reason.
  const fetchedModels = discover.data?.models ?? []
  const lastModels = useRef<DiscoveredModel[]>([])
  useEffect(() => {
    if (fetchedModels.length > 0) lastModels.current = fetchedModels
    // Initialise the tick state from the key's saved scope ONCE per dialog
    // mount. A later refetch must not wipe the operator's in-progress picks.
    if (!initializedRef.current && discover.isSuccess && fetchedModels.length > 0) {
      initializedRef.current = true
      setSelected(new Set(fetchedModels.filter(m => m.inScope !== false && !m.testUnavailable).map(m => m.id)))
    }
  }, [fetchedModels, discover.isSuccess])
  const allModels = fetchedModels.length > 0 ? fetchedModels : lastModels.current
  const needle = filter.trim().toLowerCase()
  const models = useMemo(
    () => needle ? allModels.filter(m => m.id.toLowerCase().includes(needle)) : allModels,
    [allModels, needle],
  )

  const register = useMutation<{ created: number; picked: number }>({
    meta: { silenceToast: true },
    mutationFn: async () => {
      const picked = [...selected]
      // Step 1: register any picked model that is not a chat model in the table
      // yet. Registered ones are skipped by the server, which is fine — the
      // important part is step 2: the picked set becomes the key's full scope.
      let created = 0
      const toRegister = picked.filter(id => {
        const m = allModels.find(x => x.id === id)
        return m && !m.registered
      })
      if (toRegister.length > 0) {
        const result: { created: number } = builtin
          ? await apiFetch('/api/keys/discovered-models', {
            method: 'POST',
            body: JSON.stringify({ keyId: endpoint.keyId, models: toRegister }),
          })
          : await apiFetch('/api/keys/custom', {
            method: 'POST',
            body: JSON.stringify({
              ...(endpoint.keyId === undefined ? { baseUrl: endpoint.baseUrl } : { keyId: endpoint.keyId }),
              ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
              ...(endpoint.groupLabel?.trim() ? { groupLabel: endpoint.groupLabel.trim() } : {}),
              // #1506: forward each picked model's discovered kind so the server
              // registers generic-id media/embedding models in the right table
              // instead of re-classifying by id and dropping them to chat.
              models: toRegister.map(id => {
                const discovered = allModels.find(m => m.id === id)
                return discovered?.kind ? { model: id, kind: discovered.kind } : id
              }),
            }),
          })
        created = result.created ?? 0
      }
      // Step 2: the full picked set is the key's model range. An empty pick
      // stores NULL (= unscoped, serves all) via the keys PATCH endpoint.
      if (endpoint.keyId !== undefined) {
        await apiFetch(`/api/keys/${endpoint.keyId}`, {
          method: 'PATCH',
          body: JSON.stringify({ modelScope: picked.length > 0 ? picked : null }),
        })
      }
      return { created, picked: picked.length }
    },
    onSuccess: (data) => {
      for (const key of ['keys', 'health', 'fallback', 'models']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      if (endpoint.keyId !== undefined) {
        queryClient.invalidateQueries({ queryKey: ['key-preview-models', endpoint.keyId] })
      }
      // Report the number the operator actually ticked, not just newly
      // INSERTed rows: re-ticking already-registered models only expands the
      // key's scope (0 inserts) but is still a successful "add to this key".
      toast.success(t('keys.modelsAdded', { count: data.picked }))
      onOpenChange(false)
      onRegistered?.()
    },
  })

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Only a built-in media/embedding row stays locked — it is served by its own
  // table and cannot be a chat model range. A previously registered model is NO
  // LONGER locked: the tick state means "in this key's scope", so the operator
  // can untick it to remove it from the range. Force-addable (retired) models
  // are also selectable — they are just not ticked by default.
  const locked = (m: DiscoveredModel) => builtin && m.kind !== undefined
  const selectable = models.filter(m => !locked(m))
  const allSelected = selectable.length > 0 && selectable.every(m => selected.has(m.id))
  const toggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const model of selectable) {
        if (allSelected) next.delete(model.id)
        else next.add(model.id)
      }
      return next
    })
  }

  const newCount = selected.size

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl">
        <DialogTitle>{t('keys.discoverTitle')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('keys.discoverScopeHint')}</p>

        {discover.isPending && (
          <p className="mt-4 text-xs text-muted-foreground">{t('common.loading')}</p>
        )}

        {discover.isError && (
          <p className="mt-4 text-xs text-destructive">{(discover.error as Error).message}</p>
        )}

        {discover.isSuccess && allModels.length === 0 && (
          <p className="mt-4 text-xs text-muted-foreground">{t('keys.discoverEmpty')}</p>
        )}

        {allModels.length > 0 && (
          <>
            {/* Substring filter: "free" → every id containing "free". */}
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('keys.discoverFilterPlaceholder')}
              aria-label={t('keys.discoverFilterPlaceholder')}
              className="mt-4 h-8 text-xs"
            />

            {discover.isSuccess && models.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">{t('keys.discoverNoMatch')}</p>
            )}

            {models.length > 0 && (
            <>
            <label className="mt-4 flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={toggleAll}
                className="size-4 accent-primary"
              />
              <span>{t('keys.discoverSelectAll')}</span>
            </label>
            <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-2xl border divide-y">
              {models.map(model => (
                <label
                  key={model.id}
                  className={`flex items-center gap-2 px-3 py-2 text-xs ${locked(model) ? 'bg-muted/40' : 'cursor-pointer hover:bg-muted/30'} ${model.testUnavailable ? 'bg-destructive/5' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(model.id)}
                    disabled={locked(model)}
                    onChange={() => toggle(model.id)}
                    className="size-4 accent-primary"
                  />
                  <code className="min-w-0 flex-1 truncate font-mono" title={model.id}>{model.id}</code>
                  {/* Same chips as the models table, so a discovered row reads
                      the way a registered one will. */}
                  {model.vision && (
                    <span title={t('models.visionTitle')} className="shrink-0 rounded-full bg-cyan-600/15 px-1.5 py-0.5 text-[10px] text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">
                      {t('models.vision')}
                    </span>
                  )}
                  {/* #1051: a non-chat model registers into its own table (or,
                      for video, is skipped), so say what the row IS up front. */}
                  {model.kind && (
                    <span className="shrink-0 rounded-full bg-violet-600/15 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">
                      {model.kind}
                    </span>
                  )}
                  {model.contextWindow !== undefined && model.contextWindow > 0 && (
                    <span title={t('models.ctxTitle')} className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                      {t('models.ctxBadge', { size: formatContext(model.contextWindow) })}
                    </span>
                  )}
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
                  {model.ownedBy && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">{model.ownedBy}</span>
                  )}
                  {model.testSuccessRate != null && (
                    <span
                      title={t('models.testSuccessRate')}
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
                        model.testSuccessRate >= 0.5
                          ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
                          : 'bg-amber-600/15 text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {Math.round(model.testSuccessRate * 100)}%
                    </span>
                  )}
                  {model.testUnavailable && (
                    <span title={t('models.testUnavailableHint')} className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
                      {t('models.testUnavailable')}
                    </span>
                  )}
                  {model.registered && !model.testUnavailable && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t('keys.discoverAlreadyAdded')}
                    </span>
                  )}
                </label>
              ))}
            </div>
            </>
            )}
          </>
        )}

        {register.isError && (
          <p className="mt-3 text-xs text-destructive">{(register.error as Error).message}</p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => register.mutate()}
            disabled={newCount === 0 || register.isPending}
          >
            {newCount === 1 ? t('keys.addModel') : t('keys.addModels', { count: newCount })}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
