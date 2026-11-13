import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Sparkles, Wand2, ShieldCheck, Gauge } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { ConfirmButton } from '@/components/confirm-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n'

// ── Operator tuning page (fork-only) ───────────────────────────────────────
//
// Everything the stock dashboard cannot reach: the free-only switch, the two
// bulk catalog passes, the "re-sort by ability" rewrite, the per-provider rate
// limit table and the on-demand provider refresh. Each button reports what it
// actually changed, because a no-op and a fix look identical otherwise.

interface TuningSummary {
  freeOnlyRouting: boolean
  priceTiers: { free: number; paid: number; unknown: number }
  capabilityTiers: { tier: number; label: string; count: number }[]
  enabledModels: number
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
  totals: {
    platformsQueried: number
    platformsFailed: number
    added: number
    missing: number
    retiered: number
    paidNow: number
  }
}

export default function TuningPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [report, setReport] = useState<RefreshReport | null>(null)
  const [limitDraft, setLimitDraft] = useState<Record<string, Partial<ProviderLimitRow>>>({})

  const summary = useQuery({
    queryKey: ['tuning', 'summary'],
    queryFn: () => apiFetch<TuningSummary>('/api/tuning/summary'),
  })

  const limits = useQuery({
    queryKey: ['tuning', 'limits'],
    queryFn: () => apiFetch<{ limits: ProviderLimitRow[] }>('/api/tuning/limits'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tuning'] })
    // Model enable flags and the chain order both moved, so anything showing
    // them (the models table, the fallback order) is stale too.
    void queryClient.invalidateQueries({ queryKey: ['models'] })
    void queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

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

  const refresh = useMutation({
    mutationFn: () =>
      apiFetch<RefreshReport>('/api/tuning/refresh', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: res => {
      setReport(res)
      toast.success(t('tuning.refreshDone').replace('{n}', String(res.totals.added)))
      invalidate()
    },
  })

  const saveLimit = useMutation({
    mutationFn: (payload: { platform: string; body: Partial<ProviderLimitRow> }) =>
      apiFetch<{ limits: ProviderLimitRow }>(`/api/tuning/limits/${encodeURIComponent(payload.platform)}`, {
        method: 'PUT',
        body: JSON.stringify(payload.body),
      }),
    onSuccess: () => {
      toast.success(t('tuning.done'))
      void queryClient.invalidateQueries({ queryKey: ['tuning', 'limits'] })
    },
  })

  const tiers = summary.data?.priceTiers

  return (
    <div className="max-w-5xl">
      <PageHeader title={t('tuning.title')} description={t('tuning.description')} />

      {/* ── Free-only routing ─────────────────────────────────────────── */}
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
              <Badge variant="secondary">
                {t('tuning.countEnabled')}: {summary.data?.enabledModels ?? 0}
              </Badge>
              <Badge variant="outline">{t('tuning.tierFree')}: {tiers?.free ?? 0}</Badge>
              <Badge variant="destructive">{t('tuning.tierPaid')}: {tiers?.paid ?? 0}</Badge>
              <Badge variant="ghost">{t('tuning.tierUnknown')}: {tiers?.unknown ?? 0}</Badge>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={catalogAction.isPending}
              onClick={() =>
                catalogAction.mutate({ url: '/api/tuning/disable-paid', body: { reclassify: true } })
              }
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

      {/* ── Capability tiers ──────────────────────────────────────────── */}
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

      {/* ── Provider limits ───────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" />
            {t('tuning.limitsTitle')}
          </CardTitle>
          <CardDescription>{t('tuning.limitsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {limits.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (limits.data?.limits.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{t('tuning.limitsEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left py-2 pr-3 font-medium">{t('tuning.platform')}</th>
                    <th className="text-left py-2 pr-3 font-medium">RPM</th>
                    <th className="text-left py-2 pr-3 font-medium">RPD</th>
                    <th className="text-left py-2 pr-3 font-medium">TPM</th>
                    <th className="text-left py-2 pr-3 font-medium">TPD</th>
                    <th className="text-left py-2 pr-3 font-medium">{t('tuning.concurrency')}</th>
                    <th className="text-left py-2 pr-3 font-medium">{t('tuning.scope')}</th>
                    <th className="text-right py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {(limits.data?.limits ?? []).map(row => {
                    const draft = limitDraft[row.platform] ?? {}
                    const value = (key: keyof ProviderLimitRow) => {
                      const d = draft[key]
                      if (d !== undefined) return d === null ? '' : String(d)
                      const v = row[key]
                      return v === null ? '' : String(v)
                    }
                    const set = (key: keyof ProviderLimitRow, raw: string) => {
                      const parsed = raw.trim() === '' ? null : Number(raw)
                      setLimitDraft(prev => ({
                        ...prev,
                        [row.platform]: {
                          ...prev[row.platform],
                          [key]: Number.isFinite(parsed as number) ? parsed : null,
                        },
                      }))
                    }
                    const dirty = Object.keys(draft).length > 0
                    return (
                      <tr key={row.platform} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-medium">{row.platform}</td>
                        {(['rpm', 'rpd', 'tpm', 'tpd', 'maxConcurrency'] as const).map(key => (
                          <td key={key} className="py-2 pr-3">
                            <Input
                              className="h-7 w-20 text-xs"
                              value={value(key)}
                              onChange={e => set(key, e.target.value)}
                              inputMode="numeric"
                            />
                          </td>
                        ))}
                        <td className="py-2 pr-3">
                          <Badge variant="outline">{row.scope}</Badge>
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            size="sm"
                            variant={dirty ? 'default' : 'ghost'}
                            disabled={!dirty || saveLimit.isPending}
                            onClick={() => {
                              saveLimit.mutate({ platform: row.platform, body: draft })
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

      {/* ── Refresh ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="size-4" />
            {t('tuning.refreshTitle')}
          </CardTitle>
          <CardDescription>{t('tuning.refreshDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className={refresh.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {refresh.isPending ? t('tuning.refreshing') : t('tuning.refreshNow')}
          </Button>
          {report && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {t('tuning.refreshSummary')
                  .replace('{q}', String(report.totals.platformsQueried))
                  .replace('{f}', String(report.totals.platformsFailed))
                  .replace('{a}', String(report.totals.added))
                  .replace('{m}', String(report.totals.missing))
                  .replace('{p}', String(report.totals.paidNow))}
              </p>
              <ul className="space-y-1">
                {report.platforms.map(p => (
                  <li key={p.platform} className="flex items-center gap-2 text-xs">
                    <span className="font-medium w-32 shrink-0">{p.platform}</span>
                    {p.ok ? (
                      <span className="text-muted-foreground">
                        +{p.added} / −{p.missing} / {t('tuning.paidNow')} {p.paidNow} / {p.upstreamCount}
                      </span>
                    ) : (
                      <span className="text-destructive">{p.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
