import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { History, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import type { RecentCallRow, RecentCallsResponse } from '@/pages/AnalyticsPage'

// 'canceled' is neither success nor error: neutral amber, not destructive red.
function statusTextClass(status: string): string {
  if (status === 'success') return 'text-muted-foreground'
  if (status === 'canceled') return 'text-amber-600 dark:text-amber-400'
  return 'text-destructive'
}

// ── One-click recent-calls view ────────────────────────────────────────────
//
// The full recent-calls table lives at the very bottom of the analytics page,
// below a dozen charts. The operator needs to answer "which concrete
// provider/model is serving right now, and did it work?" without scrolling, so
// the top bar carries a "Recent calls" entry that opens this dialog from ANY
// page. Rows name BOTH the model the client asked for and the provider+model
// that actually served it, with the outcome and error text inline. Clicking a
// row drills into the attempt ladder.
export function RecentCallsQuickView({
  open, onClose, rows, total, onSelect,
}: {
  open: boolean
  onClose: () => void
  rows: RecentCallRow[]
  total: number
  onSelect: (id: number) => void
}) {
  const { t } = useI18n()
  const succeeded = rows.filter(r => r.status === 'success').length
  const failed = rows.filter(r => r.status !== 'success' && r.status !== 'canceled').length
  const canceled = rows.length - succeeded - failed

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogPopup maxWidth="max-w-5xl" className="flex max-h-[85vh] flex-col overflow-hidden">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" aria-hidden="true" />
              <DialogTitle>{t('analytics.quickViewTitle')}</DialogTitle>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('analytics.quickViewHint')}</p>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary">{t('analytics.quickViewLoaded').replace('{n}', String(rows.length)).replace('{total}', String(total))}</Badge>
          <Badge variant="outline">{t('common.success')}: {succeeded}</Badge>
          <Badge variant="destructive">{t('analytics.quickViewFailed')}: {failed}</Badge>
          <Badge variant="outline">{t('analytics.quickViewCanceled')}: {canceled}</Badge>
          <span className="text-muted-foreground">{t('analytics.quickViewLive')}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead className="pl-4">{t('analytics.time')}</TableHead>
                <TableHead>{t('analytics.quickViewRequested')}</TableHead>
                <TableHead>{t('common.provider')}</TableHead>
                <TableHead>{t('analytics.quickViewServedModel')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead className="text-right">{t('analytics.attempts')}</TableHead>
                <TableHead className="text-right">{t('analytics.latency')}</TableHead>
                <TableHead className="pr-4">{t('analytics.quickViewError')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => onSelect(r.id)}>
                  <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                    {formatSqliteUtcToLocalTime(r.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </TableCell>
                  <TableCell className="text-xs max-w-[180px] truncate" title={r.requestedModel ?? r.modelId}>
                    {r.requestedModel ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs font-medium whitespace-nowrap">
                    {r.platform === 'custom' && r.keyLabel ? r.keyLabel : r.platform}
                  </TableCell>
                  <TableCell className="text-xs max-w-[220px] truncate font-medium" title={r.modelId}>
                    {r.modelId}
                  </TableCell>
                  <TableCell className={`text-xs font-medium ${statusTextClass(r.status)}`}>
                    {r.status === 'success' ? t('common.success') : r.status === 'canceled' ? t('analytics.quickViewCanceled') : t('analytics.quickViewFailed')}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{r.attemptCount > 0 ? r.attemptCount : '—'}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums whitespace-nowrap">{r.latencyMs} ms</TableCell>
                  <TableCell className="pr-4 text-xs text-destructive max-w-[240px] truncate" title={r.error ?? undefined}>
                    {r.error ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    {t('common.noData')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('analytics.quickViewDrillHint')}</p>
      </DialogPopup>
    </Dialog>
  )
}

// Top-bar launcher. It fetches its own rows so the dialog works from every
// page (models, playground, keys…), not only from /analytics. Clicking a row
// hands the id to the analytics page, which opens the attempt-ladder drill-down.
export function RecentCallsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { data } = useQuery({
    queryKey: ['analytics', 'requests', '24h', 'all', 'all'],
    queryFn: () => apiFetch<RecentCallsResponse>('/api/analytics/requests?range=24h&limit=100'),
    // "Which provider is serving right now" is a current-state question, not a
    // historical one — keep it live while the dialog is open.
    refetchInterval: open ? 5000 : false,
  })

  return (
    <RecentCallsQuickView
      open={open}
      onClose={onClose}
      rows={data?.rows ?? []}
      total={data?.total ?? 0}
      onSelect={(id) => {
        onClose()
        navigate(`/analytics?recent=1&request=${id}`)
      }}
    />
  )
}
