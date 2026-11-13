import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  RefreshCw, Sparkles, Wand2, ShieldCheck, Gauge, Layers3,
  Search, ChevronDown, ChevronRight, KeyRound, Info,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { ConfirmButton } from '@/components/confirm-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n'

// ── Operator tuning page (fork-only) ───────────────────────────────────────
//
// This is the ONE page for the localization work. Ordering is deliberate: the
// operator complained they could not find the refresh button, so it is the very
// first card AND a button in the page header; the three routing strings come
// next; the exhaustive provider-limit roster is last and covers every adapter
// this build registers, not just the seven with an enforced profile.

interface TuningSummary {
  freeOnlyRouting: boolean
  priceTiers: { free: number; paid: number; unknown: number }
  capabilityTiers: { tier: number; label: string; count: number }[]
  enabledModels: number
  routingTiers?: {
    enabled: boolean
    rounds: number
    defaultRounds: number
    maxRounds: number
    counts: { tier: number; count: number }[]
  }
}

interface ProviderLimitRow {
  platform: string
  rpm: number | null
  rpd: number | null
  tpm: number | null
  tpd: number | null
  maxConcurrency: number | null
  scope: 'model' | 'account'
  notes: string | null
  updatedAt: string
}

interface RosterRow {
  platform: string
  name: string
  kind: 'chat' | 'search'
  keyless: boolean
  limits: {
    rpm: number | null
    rpd: number | null
    tpm: number | null
    tpd: number | null
    maxConcurrency: number | null
    scope: 'model' | 'account'
  }
  notes: string | null
  quotaFacts: string | null
  configured: boolean
}

interface RoutingTierModel {
  id: number
  platform: string
  model_id: string
  display_name: string
  price_tier: string
  capability_tier: number
  routing_tier: number
  routing_tier_source: string
  enabled: number
}

interface RefreshPlatformResult {
  platform: string
  ok: boolean
  reason?: string
  added: number
  addedDisabled: number
  missing: number
  retiered: number
  upstreamCount: number
  paidNow: number
}

interface RefreshReport {
  platforms: RefreshPlatformResult[]
  skipped: { platform: string; reason: string }[]
  totals: {
    providersRegistered: number
    platformsQueried: number
    platformsFailed: number
    platformsSkipped: number
    added: number
    missing: number
    retiered: number
    paidNow: number
  }
}

const NUMERIC_FIELDS = ['rpm', 'rpd', 'tpm', 'tpd', 'maxConcurrency'] as const
type NumericField = typeof NUMERIC_FIELDS[number]
type LimitDraft = Partial<Record<NumericField | 'scope' | 'notes', string | null>>

function reasonText(reason: string, t: (k: string) => string): string {
  if (reason.includes('no /models')) return t('tuning.reasonCatalog')
  if (reason.includes('no usable key')) return t('tuning.reasonNoKey')
  if (reason.includes('keyless provider excluded')) return t('tuning.reasonKeyless')
  if (reason.includes('custom endpoints')) return t('tuning.reasonCustom')
  return reason
}

export default function TuningPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [report, setReport] = useState<RefreshReport | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const [limitDraft, setLimitDraft] = useState<Record<string, LimitDraft>>({})
  const [rosterQuery, setRosterQuery] = useState('')
  const [rosterOnlyConfigured, setRosterOnlyConfigured] = useState(false)
  const [tierQuery, setTierQuery] = useState('')
  const [tierFilter, setTierFilter] = useState('all')
  const [roundsDraft, setRoundsDraft] = useState<string | null>(null)
  const [showModels, setShowModels] = useState(false)

  const summary = useQuery({
    queryKey: ['tuning', 'summary'],
    queryFn: () => apiFetch<TuningSummary>('/api/tuning/summary'),
  })

  const tiers = useQuery({
    queryKey: ['tuning', 'routing-tiers'],
    queryFn: () => apiFetch<NonNullable<TuningSummary['routingTiers']>>('/api/tuning/routing-tiers'),
  })

  const roster = useQuery({
    queryKey: ['tuning', 'limits', 'roster'],
    queryFn: () => apiFetch<{ roster: RosterRow[] }>('/api/tuning/limits/roster'),
  })

  const models = useQuery({
    queryKey: ['tuning', 'routing-tiers', 'models', tierFilter, tierQuery],
    queryFn: () => apiFetch<{ models: RoutingTierModel[] }>(
      `/api/tuning/routing-tiers/models?tier=${encodeURIComponent(tierFilter)}&q=${encodeURIComponent(tierQuery)}&limit=200`,
    ),
    enabled: showModels,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tuning'] })
    void queryClient.invalidateQueries({ queryKey: ['models'] })
    void queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  const refresh = useMutation({
    mutationFn: () =>
      apiFetch<RefreshReport>('/api/tuning/refresh', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: res => {
      setReport(res)
      toast.success(t('tuning.refreshDone').replace('{n}', String(res.totals.added)))
      invalidate()
    },
  })

  const toggleFreeOnly = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<{ freeOnlyRouting: boolean }>('/api/tuning/free-only', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: res => {
      toast.success(res.freeOnlyRouting ? t('tuning.freeOnlyOn') : t('tuning.freeOnlyOff'))
      invalidate()
    },
  })

  const catalogAction = useMutation({
    mutationFn: (payload: { url: string; body: unknown }) =>
      apiFetch<Record<string, unknown>>(payload.url, {
        method: 'POST',
        body: JSON.stringify(payload.body ?? {}),
      }),
    onSuccess: () => {
      toast.success(t('tuning.done'))
      invalidate()
    },
  })

  const saveTiers = useMutation({
    mutationFn: (body: { enabled?: boolean; rounds?: number }) =>
      apiFetch<Record<string, unknown>>('/api/tuning/routing-tiers', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setRoundsDraft(null)
      toast.success(t('tuning.done'))
      invalidate()
    },
  })

  const assignTiers = useMutation({
    mutationFn: (includeManual: boolean) =>
      apiFetch<Record<string, unknown>>('/api/tuning/routing-tiers/assign', {
        method: 'POST',
        body: JSON.stringify({ includeManual }),
      }),
    onSuccess: res => {
      toast.success(t('tuning.tierAssigned').replace('{n}', String(res.changed ?? 0)))
      invalidate()
    },
  })

  const setModelTier = useMutation({
    mutationFn: (payload: { id: number; tier: number }) =>
      apiFetch<Record<string, unknown>>(`/api/tuning/routing-tiers/models/${payload.id}`, {
        method: 'PUT',
        body: JSON.stringify({ tier: payload.tier }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tuning'] })
    },
  })

  const saveLimit = useMutation({
    mutationFn: (payload: { platform: string; body: Record<string, unknown> }) =>
      apiFetch<{ limits: ProviderLimitRow }>(`/api/tuning/limits/${encodeURIComponent(payload.platform)}`, {
        method: 'PUT',
        body: JSON.stringify(payload.body),
      }),
    onSuccess: () => {
      toast.success(t('tuning.done'))
      void queryClient.invalidateQueries({ queryKey: ['tuning', 'limits'] })
    },
  })

  const tierState = tiers.data ?? summary.data?.routingTiers
  const tierCounts = (n: number) => tierState?.counts.find(c => c.tier === n)?.count ?? 0
  const price = summary.data?.priceTiers

  const filteredRoster = useMemo(() => {
    const q = rosterQuery.trim().toLowerCase()
    return (roster.data?.roster ?? []).filter(row => {
      if (rosterOnlyConfigured && !row.configured) return false
      if (!q) return true
      return `${row.name} ${row.platform} ${row.quotaFacts ?? ''} ${row.notes ?? ''}`.toLowerCase().includes(q)
    })
  }, [roster.data, rosterQuery, rosterOnlyConfigured])

  const refreshButton = (
    <Button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
      <RefreshCw className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'} />
      {refresh.isPending ? t('tuning.refreshing') : t('tuning.refreshAll')}
    </Button>
  )

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={t('tuning.title')}
        description={t('tuning.description')}
        actions={refreshButton}
      />

      {/* ── 1. One-click refresh: deliberately the FIRST thing on the page ── */}
      <Card className="mb-6 border-primary/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="size-4" />
            {t('tuning.refreshTitle')}
          </CardTitle>
          <CardDescription>{t('tuning.refreshDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {refreshButton}
            <span className="text-xs text-muted-foreground">{t('tuning.refreshLocation')}</span>
          </div>
          {report && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {t('tuning.refreshSummary')
                  .replace('{q}', String(report.totals.platformsQueried))
                  .replace('{f}', String(report.totals.platformsFailed))
                  .replace('{s}', String(report.totals.platformsSkipped))
                  .replace('{a}', String(report.totals.added))
                  .replace('{m}', String(report.totals.missing))
                  .replace('{p}', String(report.totals.paidNow))}
              </p>
              {report.platforms.length > 0 && (
                <ul className="space-y-1">
                  {report.platforms.map(p => (
                    <li key={p.platform} className="flex items-center gap-2 text-xs">
                      <span className="font-medium w-36 shrink-0 truncate">{p.platform}</span>
                      {p.ok ? (
                        <span className="text-muted-foreground">
                          +{p.added} / −{p.missing} / {t('tuning.paidNow')} {p.paidNow} / {p.upstreamCount}
                        </span>
                      ) : (
                        <span className="text-destructive">{reasonText(p.reason ?? '', t)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {report.skipped.length > 0 && (
                <div className="pt-1">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowSkipped(v => !v)}
                  >
                    {showSkipped ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    {t('tuning.refreshSkipped').replace('{n}', String(report.skipped.length))}
                  </button>
                  {showSkipped && (
                    <ul className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
                      {report.skipped.map(s => (
                        <li key={s.platform} className="flex items-center gap-2 text-xs">
                          <span className="font-medium w-36 shrink-0 truncate">{s.platform}</span>
                          <span className="text-muted-foreground truncate">{reasonText(s.reason, t)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 2. Three operator routing strings + configurable pass count ──── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers3 className="size-4" />
            {t('tuning.tierTitle')}
          </CardTitle>
          <CardDescription>{t('tuning.tierDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                checked={tierState?.enabled ?? true}
                disabled={tiers.isLoading || saveTiers.isPending}
                onCheckedChange={checked => saveTiers.mutate({ enabled: checked })}
              />
              <span className="text-sm">{t('tuning.tierEnabled')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm">{t('tuning.tierRounds')}</span>
              <Input
                className="h-8 w-16 text-sm"
                inputMode="numeric"
                value={roundsDraft ?? String(tierState?.rounds ?? 2)}
                onChange={e => setRoundsDraft(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                ({t('tuning.tierRoundsRange').replace('{n}', String(tierState?.maxRounds ?? 10))})
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={roundsDraft === null || saveTiers.isPending}
                onClick={() => saveTiers.mutate({ rounds: Number(roundsDraft) || 1 })}
              >
                {t('tuning.save')}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('tuning.tierRoundsHint')}</p>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="default">{t('tuning.tierFirst')}: {tierCounts(1)}</Badge>
            <Badge variant="secondary">{t('tuning.tierSecond')}: {tierCounts(2)}</Badge>
            <Badge variant="outline">{t('tuning.tierOther')}: {tierCounts(3)}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={assignTiers.isPending}
              onClick={() => assignTiers.mutate(false)}
            >
              <Sparkles className="size-3.5" />
              {t('tuning.tierAutoAssign')}
            </Button>
            <ConfirmButton
              variant="ghost"
              className="h-8 px-3 text-xs"
              confirmLabel={t('tuning.confirm')}
              onConfirm={() => assignTiers.mutate(true)}
            >
              {t('tuning.tierOverwriteManual')}
            </ConfirmButton>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowModels(v => !v)}
            >
              {showModels ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {t('tuning.tierModelsTitle')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('tuning.tierAutoAssignHint')}</p>

          {showModels && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-48 flex-1">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                  <Input
                    className="h-8 pl-7 text-xs"
                    placeholder={t('tuning.tierSearch')}
                    value={tierQuery}
                    onChange={e => setTierQuery(e.target.value)}
                  />
                </div>
                <Select value={tierFilter} onValueChange={v => setTierFilter(v ?? 'all')}>
                  <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('tuning.tierFilterAll')}</SelectItem>
                    <SelectItem value="1">{t('tuning.tierFirst')}</SelectItem>
                    <SelectItem value="2">{t('tuning.tierSecond')}</SelectItem>
                    <SelectItem value="3">{t('tuning.tierOther')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {models.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-background text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-2 pr-2 font-medium">{t('tuning.platform')}</th>
                        <th className="text-left py-2 pr-2 font-medium">{t('tuning.tierModel')}</th>
                        <th className="text-left py-2 pr-2 font-medium">{t('tuning.tierAbility')}</th>
                        <th className="text-left py-2 pr-2 font-medium">{t('tuning.tierSource')}</th>
                        <th className="text-right py-2 font-medium">{t('tuning.tierMoveTo')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(models.data?.models ?? []).map(m => (
                        <tr key={m.id} className="border-b last:border-0">
                          <td className="py-1.5 pr-2 text-muted-foreground">{m.platform}</td>
                          <td className="py-1.5 pr-2 font-medium max-w-64 truncate" title={m.model_id}>
                            {m.model_id}
                            {m.price_tier === 'paid' && <Badge variant="destructive" className="ml-1">{t('tuning.tierPaid')}</Badge>}
                          </td>
                          <td className="py-1.5 pr-2 text-muted-foreground">{m.capability_tier || '—'}</td>
                          <td className="py-1.5 pr-2 text-muted-foreground">
                            {m.routing_tier_source === 'manual' ? t('tuning.tierSourceManual') : t('tuning.tierSourceAuto')}
                          </td>
                          <td className="py-1.5 text-right">
                            <Select
                              value={String(m.routing_tier)}
                              onValueChange={v => v && setModelTier.mutate({ id: m.id, tier: Number(v) })}
                            >
                              <SelectTrigger className="ml-auto h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="1">{t('tuning.tierFirst')}</SelectItem>
                                <SelectItem value="2">{t('tuning.tierSecond')}</SelectItem>
                                <SelectItem value="3">{t('tuning.tierOther')}</SelectItem>
                              </SelectContent>
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(models.data?.models.length ?? 0) === 0 && (
                    <p className="py-4 text-center text-xs text-muted-foreground">{t('tuning.limitsEmpty')}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Free-only routing ───────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            {t('tuning.freeOnlyTitle')}
          </CardTitle>
          <CardDescription>{t('tuning.freeOnlyDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={summary.data?.freeOnlyRouting ?? true}
              disabled={summary.isLoading || toggleFreeOnly.isPending}
              onCheckedChange={checked => toggleFreeOnly.mutate(checked)}
            />
            <span className="text-sm">{t('tuning.freeOnlySwitch')}</span>
          </div>
          {summary.isLoading ? (
            <Skeleton className="h-6 w-64" />
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">{t('tuning.countEnabled')}: {summary.data?.enabledModels ?? 0}</Badge>
              <Badge variant="outline">{t('tuning.tierFree')}: {price?.free ?? 0}</Badge>
              <Badge variant="destructive">{t('tuning.tierPaid')}: {price?.paid ?? 0}</Badge>
              <Badge variant="ghost">{t('tuning.tierUnknown')}: {price?.unknown ?? 0}</Badge>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={catalogAction.isPending}
              onClick={() => catalogAction.mutate({ url: '/api/tuning/disable-paid', body: { reclassify: true } })}
            >
              {t('tuning.disablePaid')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={catalogAction.isPending}
              onClick={() => catalogAction.mutate({ url: '/api/tuning/enable-free', body: {} })}
            >
              {t('tuning.enableFree')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 4. Capability tiers ────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            {t('tuning.capabilityTitle')}
          </CardTitle>
          <CardDescription>{t('tuning.capabilityDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {(summary.data?.capabilityTiers ?? []).map(row => (
              <Badge key={row.tier} variant={row.tier === 4 ? 'destructive' : 'outline'}>
                {row.label}: {row.count}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={catalogAction.isPending}
              onClick={() => catalogAction.mutate({ url: '/api/tuning/junk', body: { action: 'recompute' } })}
            >
              {t('tuning.recompute')}
            </Button>
            <ConfirmButton
              variant="outline"
              className="h-8 px-3 text-xs"
              confirmLabel={t('tuning.confirm')}
              onConfirm={() => catalogAction.mutate({ url: '/api/tuning/junk', body: { action: 'disable', confirm: true } })}
            >
              {t('tuning.disableJunk')}
            </ConfirmButton>
            <Button
              variant="outline"
              size="sm"
              disabled={catalogAction.isPending}
              onClick={() => catalogAction.mutate({ url: '/api/tuning/junk', body: { action: 'resort' } })}
            >
              <Wand2 className="size-3.5" />
              {t('tuning.resort')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('tuning.resortHint')}</p>
        </CardContent>
      </Card>

      {/* ── 5. EVERY provider's limits, explained AND editable ──────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" />
            {t('tuning.rosterTitle')}
          </CardTitle>
          <CardDescription>{t('tuning.rosterDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                className="h-8 pl-7 text-xs"
                placeholder={t('tuning.rosterSearch')}
                value={rosterQuery}
                onChange={e => setRosterQuery(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={rosterOnlyConfigured} onCheckedChange={setRosterOnlyConfigured} />
              {t('tuning.rosterConfiguredOnly')}
            </label>
            <Badge variant="outline">
              {t('tuning.rosterCount').replace('{n}', String(filteredRoster.length))
                .replace('{total}', String(roster.data?.roster.length ?? 0))}
            </Badge>
          </div>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 mt-0.5 shrink-0" />
            {t('tuning.rosterHint')}
          </p>

          {roster.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : filteredRoster.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('tuning.limitsEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left py-2 pr-3 font-medium">{t('tuning.platform')}</th>
                    <th className="text-left py-2 pr-3 font-medium min-w-56">{t('tuning.rosterQuotaFacts')}</th>
                    {NUMERIC_FIELDS.map(key => (
                      <th key={key} className="text-left py-2 pr-3 font-medium">
                        {key === 'maxConcurrency' ? t('tuning.concurrency') : key.toUpperCase()}
                      </th>
                    ))}
                    <th className="text-left py-2 pr-3 font-medium">{t('tuning.scope')}</th>
                    <th className="text-left py-2 pr-3 font-medium min-w-40">{t('tuning.rosterNotes')}</th>
                    <th className="text-right py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {filteredRoster.map(row => {
                    const draft = limitDraft[row.platform] ?? {}
                    const value = (key: NumericField) => {
                      if (draft[key] !== undefined) return draft[key] ?? ''
                      const v = row.limits[key]
                      return v === null ? '' : String(v)
                    }
                    const setNumeric = (key: NumericField, raw: string) => {
                      const parsed = raw.trim() === '' ? null : Number(raw)
                      setLimitDraft(prev => ({
                        ...prev,
                        [row.platform]: {
                          ...prev[row.platform],
                          [key]: Number.isFinite(parsed as number) && (parsed as number) >= 0
                            ? String(Math.floor(parsed as number))
                            : null,
                        },
                      }))
                    }
                    const dirty = Object.keys(draft).length > 0
                    const scope = draft.scope ?? row.limits.scope
                    return (
                      <tr key={row.platform} className="border-b last:border-0 align-top">
                        <td className="py-2 pr-3">
                          <div className="font-medium whitespace-nowrap">{row.name}</div>
                          <div className="text-muted-foreground">{row.platform}</div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {row.configured && <Badge variant="secondary">{t('tuning.rosterEnforced')}</Badge>}
                            {row.keyless && <Badge variant="outline"><KeyRound className="size-3" />{t('tuning.rosterKeyless')}</Badge>}
                            {row.kind === 'search' && <Badge variant="outline">{t('tuning.rosterSearchOnly')}</Badge>}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {row.quotaFacts ?? t('tuning.rosterNoFacts')}
                        </td>
                        {NUMERIC_FIELDS.map(key => (
                          <td key={key} className="py-2 pr-3">
                            <Input
                              className="h-7 w-20 text-xs"
                              value={value(key)}
                              onChange={e => setNumeric(key, e.target.value)}
                              inputMode="numeric"
                            />
                          </td>
                        ))}
                        <td className="py-2 pr-3">
                          <Select
                            value={scope}
                            onValueChange={v => v && setLimitDraft(prev => ({
                              ...prev,
                              [row.platform]: { ...prev[row.platform], scope: v },
                            }))}
                          >
                            <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="account">account</SelectItem>
                              <SelectItem value="model">model</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2 pr-3">
                          <Input
                            className="h-7 w-full min-w-36 text-xs"
                            value={draft.notes !== undefined ? (draft.notes ?? '') : (row.notes ?? '')}
                            placeholder={t('tuning.rosterNotesPlaceholder')}
                            onChange={e => setLimitDraft(prev => ({
                              ...prev,
                              [row.platform]: { ...prev[row.platform], notes: e.target.value },
                            }))}
                          />
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            size="sm"
                            variant={dirty ? 'default' : 'ghost'}
                            disabled={!dirty || saveLimit.isPending}
                            onClick={() => {
                              const body: Record<string, unknown> = {}
                              for (const key of NUMERIC_FIELDS) {
                                if (draft[key] !== undefined) {
                                  body[key] = draft[key] === null || draft[key] === '' ? null : Number(draft[key])
                                }
                              }
                              if (draft.scope !== undefined) body.scope = draft.scope
                              if (draft.notes !== undefined) body.notes = draft.notes
                              saveLimit.mutate({ platform: row.platform, body })
                              setLimitDraft(prev => {
                                const next = { ...prev }
                                delete next[row.platform]
                                return next
                              })
                            }}
                          >
                            {t('tuning.save')}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
