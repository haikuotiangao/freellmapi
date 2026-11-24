import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/tooltip'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'

interface Schedule {
  enabled: boolean
  time: string
}

interface RunSummary {
  tested: number
  retired: number
  failedButKept: number
  passAt: string
  durationMs: number
}

/** Nightly model-test controls: run a pass on demand and set the daily time. */
export function ModelAutoTestControl() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [draftTime, setDraftTime] = useState<string | null>(null)

  const { data: schedule } = useQuery<Schedule>({
    queryKey: ['model-test-schedule'],
    queryFn: () => apiFetch('/api/models/test-schedule'),
  })

  const saveSchedule = useMutation({
    mutationFn: (next: Schedule) => apiFetch('/api/models/test-schedule', {
      method: 'PUT', body: JSON.stringify(next),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model-test-schedule'] })
      toast.success(t('models.testScheduleSaved'))
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const run = useMutation<RunSummary>({
    mutationFn: () => apiFetch('/api/models/test-run', { method: 'POST' }),
    onSuccess: (data) => {
      for (const key of ['models', 'fallback', 'keys']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      toast.success(t('models.testRunDone', {
        tested: data.tested, retired: data.retired, failed: data.failedButKept,
      }))
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const current: Schedule = schedule ?? { enabled: true, time: '03:00' }
  const time = draftTime ?? current.time

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border px-3 py-2 text-xs">
      <Tooltip text={t('models.testAutoHint')}>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <FlaskConical className="size-3.5" />
          {t('models.testAutoLabel')}
        </span>
      </Tooltip>
      <Switch
        checked={current.enabled}
        onCheckedChange={(enabled) => saveSchedule.mutate({ ...current, enabled })}
        aria-label={t('models.testAutoLabel')}
      />
      <Input
        type="time"
        value={time}
        onChange={e => setDraftTime(e.target.value)}
        onBlur={() => {
          if (draftTime && /^\d{2}:\d{2}$/.test(draftTime) && draftTime !== current.time) {
            saveSchedule.mutate({ ...current, time: draftTime })
            setDraftTime(null)
          } else {
            setDraftTime(null)
          }
        }}
        className="h-7 w-24 text-xs"
        aria-label={t('models.testTimeLabel')}
      />
      <Button
        variant="outline"
        size="sm"
        className="h-7"
        disabled={run.isPending}
        onClick={() => run.mutate()}
      >
        {run.isPending && <Loader2 className="size-3.5 animate-spin" />}
        {run.isPending ? t('models.testRunning') : t('models.testRunNow')}
      </Button>
    </div>
  )
}
