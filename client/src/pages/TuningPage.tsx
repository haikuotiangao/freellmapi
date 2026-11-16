import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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
  // The top bar's "Groups & providers" menu jumps straight to one of the
  // cards below (?section=tiers|providers|refresh): scroll it into view and
  // mark it, so the operator lands on the card they asked for.
  const [searchParams] = useSearchParams()
  const section = searchParams.get('section')
  const [activeSection, setActiveSection] = useState<string | null>(null)
  useEffect(() => {
    if (!section) return
    setActiveSection(section)
    const target = document.getElementById(`tuning-${section}`)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [section])
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
      <Card
        id="tuning-refresh"
        className={`mb-6 border-primary/40 scroll-mt-24 ${activeSection === 'refresh' ? 'ring-2 ring-primary' : ''}`}
      >
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
      <Card
        id="tuning-tiers"
        className={`mb-6 scroll-mt-24 ${activeSection === 'tiers' ? 'ring-2 ring-primary' : ''}`}
      >
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

      {/* ── 2b. Custom filters + model editing: right below the strings ── */}
      <FilterRulesCard />

      <ModelBulkCard />

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
      <Card
        id="tuning-providers"
        className={`mb-6 scroll-mt-24 ${activeSection === 'providers' ? 'ring-2 ring-primary' : ''}`}
      >
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

// ── Custom filter rules (自定义过滤) ────────────────────────────────────────
//
// Kept as standalone components so their own query/mutation state cannot grow
// the main tuning page's render tree. Both write through /api/tuning/*, which
// is mounted behind the same requireAuth as the rest of the dashboard.

interface FilterRule {
  id: number
  name: string
  action: 'exclude' | 'include'
  platform: string | null
  model_pattern: string | null
  routing_tier: number | null
  price_tier: string | null
  capability_tier: number | null
  enabled_state: string | null
  enabled: number
  priority: number
  created_at: string
}

interface FilterPreview {
  total: number
  remaining: number
  dropped: number
  whitelistActive: boolean
  perRule: { id: number; name: string; action: string; hits: number }[]
}

type RuleDraft = {
  name: string
  action: 'exclude' | 'include'
  platform: string
  modelPattern: string
  routingTier: string
  priceTier: string
  enabledState: string
  enabled: boolean
}

const EMPTY_RULE: RuleDraft = {
  name: '', action: 'exclude', platform: '', modelPattern: '',
  routingTier: '', priceTier: '', enabledState: '', enabled: true,
}

function ruleBody(d: RuleDraft) {
  return {
    name: d.name.trim() || 'rule',
    action: d.action,
    platform: d.platform.trim() || null,
    modelPattern: d.modelPattern.trim() || null,
    routingTier: d.routingTier ? Number(d.routingTier) : null,
    priceTier: d.priceTier || null,
    enabledState: d.enabledState || null,
    enabled: d.enabled,
  }
}

function FilterRulesCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [preview, setPreview] = useState<FilterPreview | null>(null)

  const data = useQuery({
    queryKey: ['tuning', 'filters'],
    queryFn: () => apiFetch<{ rules: FilterRule[]; preview: FilterPreview }>('/api/tuning/filters'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tuning', 'filters'] })
    void queryClient.invalidateQueries({ queryKey: ['tuning', 'summary'] })
    void queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  const save = useMutation({
    mutationFn: () => editingId === null
      ? apiFetch<Record<string, unknown>>('/api/tuning/filters', { method: 'POST', body: JSON.stringify(ruleBody(draft)) })
      : apiFetch<Record<string, unknown>>(`/api/tuning/filters/${editingId}`, { method: 'PUT', body: JSON.stringify(ruleBody(draft)) }),
    onSuccess: () => {
      toast.success(t('tuning.done'))
      setDraft(EMPTY_RULE)
      setEditingId(null)
      setShowForm(false)
      setPreview(null)
      invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch<Record<string, unknown>>(`/api/tuning/filters/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success(t('tuning.done')); invalidate() },
  })

  const toggle = useMutation({
    mutationFn: (r: FilterRule) => apiFetch<Record<string, unknown>>(`/api/tuning/filters/${r.id}`, {
      method: 'PUT', body: JSON.stringify({ enabled: r.enabled !== 1 }),
    }),
    onSuccess: () => invalidate(),
  })

  const previewDraft = useMutation({
    mutationFn: () => apiFetch<FilterPreview>('/api/tuning/filters/preview', {
      method: 'POST', body: JSON.stringify({ rule: ruleBody(draft) }),
    }),
    onSuccess: setPreview,
  })

  const rules = data.data?.rules ?? []
  const livePreview = preview ?? data.data?.preview ?? null
  const hitsById = new Map((livePreview?.perRule ?? []).map(r => [r.id, r.hits]))
  const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs'

  const openEdit = (r: FilterRule) => {
    setEditingId(r.id)
    setDraft({
      name: r.name,
      action: r.action,
      platform: r.platform ?? '',
      modelPattern: r.model_pattern ?? '',
      routingTier: r.routing_tier ? String(r.routing_tier) : '',
      priceTier: r.price_tier ?? '',
      enabledState: r.enabled_state ?? '',
      enabled: r.enabled === 1,
    })
    setShowForm(true)
    setPreview(null)
  }

  return (
    <Card id="tuning-filters" className="mb-6 scroll-mt-24">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" />
          {t('tuning.filtersTitle')}
        </CardTitle>
        <CardDescription>{t('tuning.filtersDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {livePreview && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t('tuning.filtersPreviewSummary')
              .replace('{total}', String(livePreview.total))
              .replace('{remaining}', String(livePreview.remaining))
              .replace('{dropped}', String(livePreview.dropped))}
            {livePreview.whitelistActive && <span className="ml-2 font-medium text-primary">{t('tuning.filtersWhitelist')}</span>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => { setShowForm(v => !v); setEditingId(null); setDraft(EMPTY_RULE) }}>
            {t('tuning.filtersAdd')}
          </Button>
        </div>

        {showForm && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="grid gap-2 md:grid-cols-3">
              <Input
                className="h-8 text-xs"
                placeholder={t('tuning.filtersNamePlaceholder')}
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              />
              <select
                className={selectClass}
                value={draft.action}
                onChange={e => setDraft(d => ({ ...d, action: e.target.value as RuleDraft['action'] }))}
              >
                <option value="exclude">{t('tuning.filtersExclude')}</option>
                <option value="include">{t('tuning.filtersInclude')}</option>
              </select>
              <Input
                className="h-8 text-xs"
                placeholder={t('tuning.platform')}
                value={draft.platform}
                onChange={e => setDraft(d => ({ ...d, platform: e.target.value }))}
              />
              <Input
                className="h-8 text-xs md:col-span-2"
                placeholder={t('tuning.filtersPatternHint')}
                value={draft.modelPattern}
                onChange={e => setDraft(d => ({ ...d, modelPattern: e.target.value }))}
              />
              <select
                className={selectClass}
                value={draft.routingTier}
                onChange={e => setDraft(d => ({ ...d, routingTier: e.target.value }))}
              >
                <option value="">{t('tuning.filtersAny')} · {t('tuning.modelsTier')}</option>
                <option value="1">{t('tuning.tierFirst')}</option>
                <option value="2">{t('tuning.tierSecond')}</option>
                <option value="3">{t('tuning.tierOther')}</option>
              </select>
              <select
                className={selectClass}
                value={draft.priceTier}
                onChange={e => setDraft(d => ({ ...d, priceTier: e.target.value }))}
              >
                <option value="">{t('tuning.filtersAny')} · {t('tuning.modelsPrice')}</option>
                <option value="free">{t('tuning.tierFree')}</option>
                <option value="paid">{t('tuning.tierPaid')}</option>
                <option value="unknown">{t('tuning.tierUnknown')}</option>
              </select>
              <select
                className={selectClass}
                value={draft.enabledState}
                onChange={e => setDraft(d => ({ ...d, enabledState: e.target.value }))}
              >
                <option value="">{t('tuning.filtersAny')} · {t('tuning.tierEnabled')}</option>
                <option value="enabled">{t('tuning.tierEnabled')}</option>
                <option value="disabled">{t('tuning.filtersOff')}</option>
              </select>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={draft.enabled} onCheckedChange={v => setDraft(d => ({ ...d, enabled: v }))} />
                {t('tuning.tierEnabled')}
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                {editingId === null ? t('tuning.filtersAdd') : t('tuning.filtersSaveEdit')}
              </Button>
              <Button size="sm" variant="outline" disabled={previewDraft.isPending} onClick={() => previewDraft.mutate()}>
                {t('tuning.filtersPreview')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowForm(false); setEditingId(null); setDraft(EMPTY_RULE); setPreview(null) }}>
                {t('tuning.filtersCancel')}
              </Button>
            </div>
          </div>
        )}

        {rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('tuning.filtersEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 pr-3 font-medium">{t('tuning.filtersName')}</th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.filtersAction')}</th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.filtersPattern')}</th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.filtersHits').replace('{n}', '')}</th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.tierEnabled')}</th>
                  <th className="py-2 text-right font-medium">{t('tuning.save')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={r.action === 'exclude' ? 'destructive' : 'secondary'}>
                        {r.action === 'exclude' ? t('tuning.filtersExclude') : t('tuning.filtersInclude')}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 font-mono text-muted-foreground">
                      {[r.platform, r.model_pattern, r.routing_tier ? `T${r.routing_tier}` : '', r.price_tier].filter(Boolean).join(' / ') || t('tuning.filtersAny')}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {t('tuning.filtersHits').replace('{n}', String(hitsById.get(r.id) ?? 0))}
                    </td>
                    <td className="py-2 pr-3">
                      <Switch checked={r.enabled === 1} onCheckedChange={() => toggle.mutate(r)} />
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>{t('tuning.filtersEdit')}</Button>
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          onConfirm={() => remove.mutate(r.id)}
                        >
                          {t('tuning.filtersDelete')}
                        </ConfirmButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Model editing / bulk editing (编辑模型) ─────────────────────────────────

interface EditableModel {
  id: number
  platform: string
  model_id: string
  display_name: string
  price_tier: string
  price_note: string | null
  capability_tier: number
  routing_tier: number
  routing_tier_source: string
  enabled: number
  key_id: number | null
}

function ModelBulkCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [platform, setPlatform] = useState('')
  const [tier, setTier] = useState('')
  const [price, setPrice] = useState('routable')
  const [configuredOnly, setConfiguredOnly] = useState(true)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkTier, setBulkTier] = useState('')
  const [bulkPrice, setBulkPrice] = useState('')
  const [bulkEnabled, setBulkEnabled] = useState('')
  const limit = 50

  const data = useQuery({
    queryKey: ['tuning', 'models', q, platform, tier, price, configuredOnly, offset],
    queryFn: () => apiFetch<{
      models: EditableModel[]
      total: number
      platforms: string[]
      configuredPlatforms: string[]
    }>(
      `/api/tuning/models?q=${encodeURIComponent(q)}&platform=${encodeURIComponent(platform)}`
      + `&tier=${encodeURIComponent(tier)}&price=${encodeURIComponent(price)}`
      + `&configuredOnly=${configuredOnly ? '1' : '0'}&limit=${limit}&offset=${offset}`,
    ),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tuning'] })
    void queryClient.invalidateQueries({ queryKey: ['models'] })
    void queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  const singleEdit = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch<Record<string, unknown>>(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

  const singleTier = useMutation({
    mutationFn: ({ id, value }: { id: number; value: number }) =>
      apiFetch<Record<string, unknown>>(`/api/tuning/routing-tiers/models/${id}`, {
        method: 'PUT', body: JSON.stringify({ tier: value }),
      }),
    onSuccess: invalidate,
  })

  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<Record<string, unknown>>('/api/tuning/models/bulk', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: res => {
      toast.success(t('tuning.done') + ` (${String(res.updated ?? 0)})`)
      setSelected(new Set())
      setBulkTier(''); setBulkPrice(''); setBulkEnabled('')
      invalidate()
    },
  })

  const rows = data.data?.models ?? []
  const total = data.data?.total ?? 0
  const platforms = data.data?.platforms ?? []
  const configuredPlatforms = data.data?.configuredPlatforms ?? []
  const selectClass = 'h-7 rounded-md border border-input bg-background px-1 text-[11px]'
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id))
  const tierLabel = (n: number) =>
    n === 1 ? t('tuning.tierFirst') : n === 2 ? t('tuning.tierSecond') : t('tuning.tierOther')
  // Rows arrive pre-sorted 1 → 2 → 3, so a group break is just "the tier
  // changed". Rendering the header here (rather than as extra <tr>s the API
  // would have to model) keeps the count correct even mid-group on a page edge.
  const tierGroups = rows.reduce<{ tier: number; items: EditableModel[] }[]>((acc, r) => {
    const last = acc[acc.length - 1]
    if (last && last.tier === r.routing_tier) last.items.push(r)
    else acc.push({ tier: r.routing_tier, items: [r] })
    return acc
  }, [])

  const applyBulk = () => {
    const patch: Record<string, unknown> = {}
    if (bulkTier) patch.routingTier = Number(bulkTier)
    if (bulkPrice) patch.priceTier = bulkPrice
    if (bulkEnabled) patch.enabled = bulkEnabled === '1'
    if (selected.size === 0 || Object.keys(patch).length === 0) return
    bulk.mutate({ ids: [...selected], patch })
  }

  return (
    <Card id="tuning-models" className="mb-6 scroll-mt-24">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers3 className="size-4" />
          {t('tuning.modelsTitle')}
        </CardTitle>
        <CardDescription>{t('tuning.modelsDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" />
            <Input
              className="h-8 w-56 pl-7 text-xs"
              placeholder={t('tuning.tierSearch')}
              value={q}
              onChange={e => { setQ(e.target.value); setOffset(0); setSelected(new Set()) }}
            />
          </div>
          <select className={selectClass} value={platform} onChange={e => { setPlatform(e.target.value); setOffset(0) }}>
            <option value="">{t('tuning.tierFilterAll')} · {t('tuning.platform')}</option>
            {platforms.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className={selectClass} value={tier} onChange={e => { setTier(e.target.value); setOffset(0) }}>
            <option value="">{t('tuning.tierFilterAll')} · {t('tuning.modelsTier')}</option>
            <option value="1">{t('tuning.tierFirst')}</option>
            <option value="2">{t('tuning.tierSecond')}</option>
            <option value="3">{t('tuning.tierOther')}</option>
          </select>
          <select className={selectClass} value={price} onChange={e => { setPrice(e.target.value); setOffset(0) }}>
            <option value="">{t('tuning.modelsPriceAll')}</option>
            <option value="routable">{t('tuning.modelsPriceRoutable')}</option>
            <option value="free">{t('tuning.tierFree')}</option>
            <option value="unknown">{t('tuning.tierUnknown')}</option>
            <option value="paid">{t('tuning.tierPaid')}</option>
          </select>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={configuredOnly} onCheckedChange={v => { setConfiguredOnly(v); setOffset(0) }} />
            {t('tuning.modelsConfiguredOnly')}
          </label>
          <span className="text-xs text-muted-foreground">
            {t('tuning.modelsTotal').replace('{n}', String(total))}
          </span>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5 mt-0.5 shrink-0" />
          {configuredOnly
            ? t('tuning.modelsConfiguredHint').replace('{n}', String(configuredPlatforms.length))
            : t('tuning.modelsAllHint')}
          {' '}
          {t('tuning.modelsOrderHint')}
        </p>

        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-xs font-medium">{t('tuning.modelsSelected').replace('{n}', String(selected.size))}</span>
          <select className={selectClass} value={bulkTier} onChange={e => setBulkTier(e.target.value)}>
            <option value="">{t('tuning.tierMoveTo')}</option>
            <option value="1">{t('tuning.tierFirst')}</option>
            <option value="2">{t('tuning.tierSecond')}</option>
            <option value="3">{t('tuning.tierOther')}</option>
          </select>
          <select className={selectClass} value={bulkPrice} onChange={e => setBulkPrice(e.target.value)}>
            <option value="">{t('tuning.modelsPrice')}</option>
            <option value="free">{t('tuning.tierFree')}</option>
            <option value="paid">{t('tuning.tierPaid')}</option>
            <option value="unknown">{t('tuning.tierUnknown')}</option>
          </select>
          <select className={selectClass} value={bulkEnabled} onChange={e => setBulkEnabled(e.target.value)}>
            <option value="">{t('tuning.tierEnabled')}</option>
            <option value="1">{t('tuning.enableFree')}</option>
            <option value="0">{t('tuning.filtersOff')}</option>
          </select>
          <Button size="sm" disabled={bulk.isPending || selected.size === 0} onClick={applyBulk}>
            {t('tuning.modelsBulkApply')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('tuning.modelsBulkHint')}</span>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('tuning.modelsEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="w-8 py-2 pr-2">
                    <input
                      type="checkbox"
                      aria-label={t('tuning.modelsSelectAll')}
                      checked={allSelected}
                      onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())}
                    />
                  </th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.tierModel')}</th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.platform')}</th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.modelsTier')}</th>
                  <th className="py-2 pr-3 font-medium">{t('tuning.modelsPrice')}</th>
                  <th className="py-2 text-right font-medium">{t('tuning.tierEnabled')}</th>
                </tr>
              </thead>
              {tierGroups.map(group => (
                <tbody key={group.tier}>
                  <tr className="bg-muted/50">
                    <td colSpan={6} className="py-1.5 pr-2 text-[11px] font-medium text-muted-foreground">
                      {tierLabel(group.tier)}
                      <span className="ml-2 font-normal">
                        {t('tuning.modelsGroupCount').replace('{n}', String(group.items.length))}
                      </span>
                    </td>
                  </tr>
                  {group.items.map(r => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={e => setSelected(prev => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(r.id); else next.delete(r.id)
                            return next
                          })}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="font-mono">{r.model_id}</div>
                        <div className="text-muted-foreground">{r.display_name}</div>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {r.platform}
                        {r.key_id != null && (
                          <span className="ml-1 text-[10px] text-primary" title={t('tuning.modelsBoundKey')}>●</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className={selectClass}
                          value={r.routing_tier}
                          onChange={e => singleTier.mutate({ id: r.id, value: Number(e.target.value) })}
                        >
                          <option value="1">{t('tuning.tierFirst')}</option>
                          <option value="2">{t('tuning.tierSecond')}</option>
                          <option value="3">{t('tuning.tierOther')}</option>
                        </select>
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className={selectClass}
                          value={r.price_tier}
                          onChange={e => singleEdit.mutate({ id: r.id, body: { priceTier: e.target.value } })}
                        >
                          <option value="free">{t('tuning.tierFree')}</option>
                          <option value="paid">{t('tuning.tierPaid')}</option>
                          <option value="unknown">{t('tuning.tierUnknown')}</option>
                        </select>
                      </td>
                      <td className="py-2 text-right">
                        <Switch
                          checked={r.enabled === 1}
                          onCheckedChange={v => singleEdit.mutate({ id: r.id, body: { enabled: v } })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - limit))}>
            {t('tuning.modelsPrev')}
          </Button>
          <Button size="sm" variant="outline" disabled={offset + limit >= total} onClick={() => setOffset(o => o + limit)}>
            {t('tuning.modelsNext')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('tuning.modelsPage').replace('{n}', String(Math.floor(offset / limit) + 1))}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
