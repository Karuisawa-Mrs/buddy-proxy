import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CreditSummarySchema,
  GetBalanceResponseSchema,
  UpstreamQuotaSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { RefreshButton } from '@/components/layout/refresh-button'
import { mockAdminClient } from '@/test/mock-transport'
import { QueryClient } from '@tanstack/react-query'
import { renderWithClient } from '@/test/render'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
}))

/** 一个账号的额度。 */
function quotaFor(upstreamId: string, accountId: string, remaining = 100) {
  return create(UpstreamQuotaSchema, {
    upstreamId,
    accountId,
    credits: create(CreditSummarySchema, { total: 100, used: 0, remaining }),
  })
}

describe('额度页首屏：只读快照，不等全量', () => {
  it('首屏带 peek；快照里的数先画出来，那一家的现数还没回来也不等', async () => {
    const asked: { upstreamId: string; peek: boolean }[] = []
    const client = mockAdminClient({
      GetBalance: (input) => {
        asked.push({ upstreamId: input.upstreamId ?? '', peek: Boolean(input.peek) })
        if (!input.upstreamId) {
          return create(GetBalanceResponseSchema, {
            upstreamIds: ['qoder'],
            quotas: [quotaFor('qoder', 'qoder-1', 42)],
          })
        }
        // 这一家的现数一直不回来：页面照样有数。
        return new Promise<never>(() => {})
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('qoder-1')).toBeInTheDocument()
    expect(screen.getByText(/42/)).toBeInTheDocument()
    expect(asked[0]).toEqual({ upstreamId: '', peek: true })
    await waitFor(() => {
      expect(asked.some((call) => call.upstreamId === 'qoder' && !call.peek)).toBe(true)
    })
  })

  it('同一平台的两个账号：按平台问一次，按账号各画一张卡', async () => {
    const asked: string[] = []
    const client = mockAdminClient({
      GetBalance: (input) => {
        asked.push(input.upstreamId ?? '')
        if (!input.upstreamId) {
          return create(GetBalanceResponseSchema, { upstreamIds: ['minimax'] })
        }
        return create(GetBalanceResponseSchema, {
          quotas: [quotaFor('minimax', 'minimax'), quotaFor('minimax', 'minimax-2')],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('minimax-2')).toBeInTheDocument()
    expect(screen.getAllByText('minimax').length).toBeGreaterThan(0)
    expect(asked.filter((id) => id === 'minimax')).toHaveLength(1)
    expect(asked).not.toContain('minimax-2')
  })
})

describe('单家没问到', () => {
  it('有旧数：照画旧数，并说这一轮没问到', async () => {
    const client = mockAdminClient({
      GetBalance: (input) => {
        if (!input.upstreamId) {
          return create(GetBalanceResponseSchema, { upstreamIds: ['qoder'] })
        }
        const stale = quotaFor('qoder', 'qoder-1', 70)
        stale.error = 'HTTP 500'
        stale.stale = true
        return create(GetBalanceResponseSchema, { quotas: [stale] })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText(/这一轮没问到额度，下面是上一次的数：HTTP 500/)).toBeInTheDocument()
    expect(screen.getByText(/70/)).toBeInTheDocument()
  })

  it('一次也没问到过：账号照样有一张错误卡，不消失', async () => {
    const client = mockAdminClient({
      GetBalance: (input) => {
        if (!input.upstreamId) {
          return create(GetBalanceResponseSchema, { upstreamIds: ['qoder'] })
        }
        return create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'qoder',
              accountId: 'qoder-1',
              error: '上游超时',
            }),
          ],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('qoder-1')).toBeInTheDocument()
    expect(screen.getByText('这个账号的额度没问到：上游超时')).toBeInTheDocument()
    expect(screen.queryByText('Provider 没有报额度。')).toBeNull()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('刷新额度', () => {
  it('刷完按前缀失效：后来才出现的平台也会重问', async () => {
    const user = userEvent.setup({ delay: null })
    let platforms = ['qoder']
    const asked: { upstreamId: string; force: boolean }[] = []
    const client = mockAdminClient({
      GetBalance: (input) => {
        asked.push({ upstreamId: input.upstreamId ?? '', force: Boolean(input.force) })
        if (!input.upstreamId) {
          // 刷新那一趟之后多了一个平台。
          if (input.force) platforms = ['qoder', 'zcode']
          return create(GetBalanceResponseSchema, { upstreamIds: platforms })
        }
        return create(GetBalanceResponseSchema, {
          quotas: [quotaFor(input.upstreamId, `acc-${input.upstreamId}`)],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })
    await screen.findByText('acc-qoder')

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    expect(await screen.findByText('acc-zcode')).toBeInTheDocument()
    await waitFor(() => {
      expect(asked.filter((c) => c.upstreamId === 'qoder')).toHaveLength(2)
    })
  })
})

describe('全局刷新按钮', () => {
  it('不碰额度的查询（那会把每家上游都问一遍）', async () => {
    const user = userEvent.setup({ delay: null })
    // 默认的 gcTime：没人订阅的查询也留在缓存里，才看得见它有没有被失效。
    const queryClient = new QueryClient()
    let balanceCalls = 0
    let otherCalls = 0
    await queryClient.prefetchQuery({
      queryKey: ['balance', 'qoder'],
      queryFn: () => ++balanceCalls,
      staleTime: Infinity,
    })
    await queryClient.prefetchQuery({
      queryKey: ['upstreams'],
      queryFn: () => ++otherCalls,
      staleTime: Infinity,
    })

    renderWithClient({
      client: mockAdminClient({}),
      queryClient,
      children: <RefreshButton />,
    })
    await user.click(screen.getByRole('button', { name: '刷新' }))

    expect(queryClient.getQueryState(['balance', 'qoder'])?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(['upstreams'])?.isInvalidated).toBe(true)
    expect(balanceCalls).toBe(1)
  })
})
