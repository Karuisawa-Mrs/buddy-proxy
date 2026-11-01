import { RefreshCw } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { QuotaDetail } from '@/features/balance/quota'
import { describeError } from '@/lib/errors'
import type { UpstreamQuota } from '@/gen/buddy/admin/v1/admin_pb'

/** 这条额度里有没有数（三样里有一样就算）。 */
function hasAnyQuota(quota: UpstreamQuota): boolean {
  return Boolean(
    quota.balance || quota.credits || (quota.tokenPlan?.windows?.length ?? 0) > 0
  )
}

/**
 * 一个账号的额度卡。
 *
 * 标题按账号分：主行写账号，副行小字写平台。这一轮没问到（error）时：有旧数
 * 就照画旧数并说明是旧的；一次也没问到过就画一张错误卡 —— 账号不能从页面上
 * 消失。
 */
export function QuotaCard({
  quota,
  refreshing,
  onRetry,
}: {
  quota: UpstreamQuota
  refreshing?: boolean
  onRetry?: () => void
}) {
  const title = quota.accountId || quota.upstreamId || '未知 Provider'
  const subtitle = quota.upstreamId === title ? '' : quota.upstreamId
  const hasData = hasAnyQuota(quota)
  // 「是不是旧数」以后端的 stale 为准：error 与有数同时出现不一定就是旧数。
  const stale = quota.stale && hasData
  return (
    <div>
      <Card className='mb-4'>
        <CardHeader>
          <div className='flex items-center gap-2'>
            <CardTitle className='text-base'>{title}</CardTitle>
            {refreshing ? (
              <RefreshCw
                className='size-3 animate-spin text-muted-foreground'
                aria-label='刷新中'
              />
            ) : null}
          </div>
          {subtitle ? (
            <p className='text-xs text-muted-foreground'>{subtitle}</p>
          ) : null}
        </CardHeader>
        <CardContent className='px-0'>
          {quota.error ? (
            <div className='grid gap-2 px-6 pb-4' role='alert'>
              <p
                className={
                  stale
                    ? 'text-sm text-amber-600 dark:text-amber-400'
                    : 'text-sm text-destructive'
                }
              >
                {stale
                  ? `这一轮没问到额度，下面是上一次的数：${quota.error}`
                  : `这个账号的额度没问到：${quota.error}`}
              </p>
              {onRetry ? (
                <div>
                  <Button variant='outline' size='sm' onClick={onRetry}>
                    重试
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {hasData ? (
            <div className={stale ? 'opacity-60' : undefined}>
              <QuotaDetail quota={quota} />
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Separator className='mb-4' />
    </div>
  )
}

/** 一家平台的额度没问出来：只这张卡自己报错。 */
export function QuotaErrorCard({
  upstreamId,
  error,
  onRetry,
}: {
  upstreamId: string
  error: Error
  onRetry: () => void
}) {
  return (
    <div>
      <Card className='mb-4'>
        <CardHeader>
          <CardTitle className='text-base'>{upstreamId}</CardTitle>
          <p className='text-xs text-muted-foreground'>
            这一家的额度没问出来
          </p>
        </CardHeader>
        <CardContent className='px-0'>
          <div className='grid gap-3 px-6 pb-4'>
            <p className='text-sm text-destructive'>{describeError(error)}</p>
            <div>
              <Button variant='outline' size='sm' onClick={onRetry}>
                重试
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <Separator className='mb-4' />
    </div>
  )
}

/**
 * 所有平台都没问出来：一行提示加一个统一重试。
 *
 * 逐卡点重试在「全军覆没」时最烦人 —— 每张卡底下都有一个重试按钮，
 * 用户得挨个点。这里一次全部重问。
 */
export function AllUpstreamsFailedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className='mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3'>
      <p className='text-sm text-destructive'>所有上游都没问出来</p>
      <Button variant='outline' size='sm' onClick={onRetry}>
        全部重试
      </Button>
    </div>
  )
}

/**
 * 额度卡片的骨架：数还没回来，先把位置占住。
 *
 * 首屏清单还没到的时候不知道有几家平台，就先摆几张空卡。
 */
export function QuotaSkeletonList() {
  return (
    <div>
      <p className='mb-4 text-sm text-muted-foreground'>正在读取额度…</p>
      {[0, 1, 2].map((index) => (
        <QuotaSkeletonCard key={index} />
      ))}
    </div>
  )
}

export function QuotaSkeletonCard({ title }: { title?: string }) {
  return (
    <div>
      <Card className='mb-4'>
        <CardHeader>
          <CardTitle className='text-base'>
            {title ?? (
              <span className='block h-4 w-24 animate-pulse rounded bg-muted' />
            )}
          </CardTitle>
          <div className='mt-1 h-3 w-16 animate-pulse rounded bg-muted' />
        </CardHeader>
        <CardContent className='px-0'>
          <div className='grid gap-3 px-6 pb-4'>
            <div className='h-4 w-32 animate-pulse rounded bg-muted' />
            <div className='h-3 w-48 animate-pulse rounded bg-muted' />
          </div>
        </CardContent>
      </Card>
      <Separator className='mb-4' />
    </div>
  )
}

export function EmptyQuotaCard() {
  return (
    <Card>
      <CardContent className='py-12 text-center text-sm text-muted-foreground'>
        Provider 没有报额度。
      </CardContent>
    </Card>
  )
}
