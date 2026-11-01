import { RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import { PageShell } from '@/components/layout/page-shell'
import { ErrorState } from '@/components/async-state'
import { Button } from '@/components/ui/button'
import {
  useBalanceOverview,
  useBalances,
  useRefreshBalance,
} from '@/features/balance/api'
import {
  AllUpstreamsFailedNotice,
  EmptyQuotaCard,
  QuotaCard,
  QuotaErrorCard,
  QuotaSkeletonCard,
  QuotaSkeletonList,
} from '@/features/balance/cards'
import type { UpstreamQuota } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 这块额度里有没有数。
 *
 * 余额 0、积分 0 都算没数：平台有时会先给一条空壳记录（额度已经用完），
 * 归并时要跳过空壳记录，去找真正带数的那条。
 *
 * 只看还剩多少（余额的 availableCny、积分的 remaining）：已用多少、什么时候
 * 到期都不算「有值」 —— 那两个字段不说明还剩多少。额度用尽的账号不该被
 * 当成可用。
 */
function hasCredits(credits: UpstreamQuota['credits']): boolean {
  if (!credits) return false
  return credits.remaining > 0
}

function hasBalance(balance: UpstreamQuota['balance']): boolean {
  if (!balance) return false
  return balance.availableCny > 0
}

/** 换掉额度记录里的三块内容，账号身份信息保持不变。 */
function replaceParts(
  quota: UpstreamQuota,
  parts: Pick<UpstreamQuota, 'tokenPlan' | 'credits' | 'balance'>,
): UpstreamQuota {
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(quota)) as UpstreamQuota,
    quota,
  )
  return Object.assign(copy, parts)
}

/**
 * 同一账号的多条额度记录归并成一条。
 *
 * 按 upstreamId + accountId 归组，保留首次出现的顺序。
 * 额度单位不同（套餐额度是百分点，积分是点数，余额是钱），所以不求和：
 * 套餐额度取第一个有窗口的，积分与余额取第一个带数的，都没有就留第一条的。
 */
export function mergeQuotas(quotas: UpstreamQuota[]): UpstreamQuota[] {
  const groups = new Map<string, UpstreamQuota[]>()
  for (const quota of quotas) {
    const key = `${quota.upstreamId}|${quota.accountId}`
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(quota)
    } else {
      groups.set(key, [quota])
    }
  }

  const merged: UpstreamQuota[] = []
  for (const bucket of groups.values()) {
    const first = bucket[0]
    const tokenPlan =
      bucket.find((quota) => (quota.tokenPlan?.windows?.length ?? 0) > 0)?.tokenPlan ??
      first.tokenPlan
    const credits =
      bucket.find((quota) => hasCredits(quota.credits))?.credits ?? first.credits
    const balance =
      bucket.find((quota) => hasBalance(quota.balance))?.balance ?? first.balance
    merged.push(replaceParts(first, { tokenPlan, credits, balance }))
  }
  return merged
}

/** 一条平台的额度查询。 */
type BalanceQuery = ReturnType<typeof useBalances>[number]

export function BalancePage() {
  // 首屏只读快照（peek）：已有的数先画出来，也由它认出有哪些平台。
  const overview = useBalanceOverview()
  const refresh = useRefreshBalance()

  // 平台清单：后端给的名单，加上快照里出现过的平台，按头一次出现的次序。
  const upstreamIds = useMemo(() => {
    const ids: string[] = []
    for (const id of overview.data?.upstreamIds ?? []) {
      if (id && !ids.includes(id)) ids.push(id)
    }
    for (const quota of overview.data?.quotas ?? []) {
      if (quota.upstreamId && !ids.includes(quota.upstreamId)) {
        ids.push(quota.upstreamId)
      }
    }
    return ids
  }, [overview.data])

  // 每家平台各问一趟现数：谁先回来谁先换掉快照里的数，慢的不拖累快的。
  const queries = useBalances(upstreamIds)

  const cardCount = queries.reduce(
    (sum, query) =>
      sum + (query.isSuccess ? mergeQuotas(query.data?.quotas ?? []).length : 0),
    0
  )
  const pending = queries.some((query) => query.isPending)
  const failed = queries.some((query) => query.isError)

  // 全家都没问出来：给一个统一入口，不用一张卡一张卡点重试。
  // 只有部分失败不算 —— 那时逐卡报错更清楚是哪几家出的问题。
  const allFailed = queries.length > 0 && queries.every((query) => query.isError)

  const onRetryAll = () => {
    for (const query of queries) {
      if (query.isError) {
        void query.refetch()
      }
    }
  }

  return (
    <PageShell
      title='额度'
      description='各账号的额度。余额、积分与套餐额度分别列示。'
      actions={
        <Button
          variant='outline'
          size='sm'
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw
            className={refresh.isPending ? 'size-4 animate-spin' : 'size-4'}
          />
          {refresh.isPending ? '正在刷新…' : '刷新额度'}
        </Button>
      }
    >
      {overview.isPending ? (
        <QuotaSkeletonList />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      ) : upstreamIds.length === 0 ? (
        <EmptyQuotaCard />
      ) : (
        <>
          {allFailed ? (
            <AllUpstreamsFailedNotice onRetry={onRetryAll} />
          ) : null}
          {upstreamIds.map((upstreamId, index) => {
            const query = queries[index]
            if (!query) return null
            return (
              <UpstreamQuotaCards
                key={upstreamId}
                upstreamId={upstreamId}
                query={query}
                snapshot={(overview.data?.quotas ?? []).filter(
                  (quota) => quota.upstreamId === upstreamId
                )}
              />
            )
          })}
          {!pending && !failed && cardCount === 0 ? (
            <EmptyQuotaCard />
          ) : null}
        </>
      )}
    </PageShell>
  )
}

/**
 * 一家平台的额度卡，一个账号一张。
 *
 * 这一家的现数还没回来：先画快照里的数（转圈表示在问），快照里也没有才摆骨架。
 * 问失败了：只这一家报错，别的卡照常。转圈只跟这一家自己的查询走。
 */
function UpstreamQuotaCards({
  upstreamId,
  query,
  snapshot,
}: {
  upstreamId: string
  query: BalanceQuery
  snapshot: UpstreamQuota[]
}) {
  const retry = () => {
    void query.refetch()
  }
  if (query.isError) {
    return (
      <QuotaErrorCard
        upstreamId={upstreamId}
        error={query.error as Error}
        onRetry={retry}
      />
    )
  }
  const source = query.isSuccess ? (query.data?.quotas ?? []) : snapshot
  if (query.isPending && source.length === 0) {
    return <QuotaSkeletonCard title={upstreamId} />
  }
  const quotas = mergeQuotas(source)
  return (
    <>
      {quotas.map((quota) => (
        <QuotaCard
          key={`${quota.upstreamId}|${quota.accountId}`}
          quota={quota}
          refreshing={query.isFetching}
          onRetry={quota.error ? retry : undefined}
        />
      ))}
    </>
  )
}
