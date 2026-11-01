import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { Code, ConnectError } from '@connectrpc/connect'
import {
  GetLoginStatusResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListUpstreamsResponseSchema,
  LoginSessionSchema,
  ProviderPolicy,
  UpstreamSchema,
  AccountSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { clearCacheOnTokenChange } from '@/lib/query-client'
import { safeHttpUrl } from '@/lib/safe-url'
import { clearToken, setToken } from '@/features/auth/token-store'
import { render } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { AdminClientProvider } from '@/features/auth/client-provider'
import { createAppRouter } from '@/router'
import { RouterProvider } from '@tanstack/react-router'
import {
  GetUsageSummaryResponseSchema,
  ListUsageEventsResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { makeTestQueryClient } from '@/test/render'
import { usageWindowOf } from '@/features/usage/windows'
import { LoginDialog } from '@/features/login/login-dialog'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
}))

describe('令牌变了就清缓存', () => {
  // 别的用例默认是已登录（test/setup.ts 写的 test-token）：用完还回去。
  afterEach(() => setToken('test-token'))

  it('登出（清令牌）：缓存清空', () => {
    setToken('t1')
    const client = new QueryClient()
    const stop = clearCacheOnTokenChange(client)
    client.setQueryData(['accounts'], { secret: 'x' })

    clearToken()

    expect(client.getQueryData(['accounts'])).toBeUndefined()
    stop()
  })

  it('换了一个令牌：缓存清空；令牌没变：不清', () => {
    setToken('t1')
    const client = new QueryClient()
    const stop = clearCacheOnTokenChange(client)
    client.setQueryData(['accounts'], 1)

    setToken('t1')
    expect(client.getQueryData(['accounts'])).toBe(1)

    setToken('t2')
    expect(client.getQueryData(['accounts'])).toBeUndefined()
    stop()
  })
})

describe('授权链接只放行 http / https', () => {
  it('javascript: 与 data: 被拒', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeHttpUrl(' JavaScript:alert(1)')).toBeUndefined()
    expect(safeHttpUrl('data:text/html,<script>1</script>')).toBeUndefined()
    expect(safeHttpUrl('not a url')).toBeUndefined()
    expect(safeHttpUrl('')).toBeUndefined()
  })

  it('https 与 http 照常', () => {
    expect(safeHttpUrl('https://example.test/a?b=1')).toBe('https://example.test/a?b=1')
    expect(safeHttpUrl('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })

  it('登录框里 javascript: 的授权链接点不动（没有 href）', async () => {
    const client = mockAdminClient({
      GetLoginStatus: () =>
        create(GetLoginStatusResponseSchema, {
          ok: true,
          session: create(LoginSessionSchema, {
            loginId: 'login-1',
            upstreamId: 'minimax',
            accountId: 'minimax',
            status: 'pending',
            method: 'browser',
            authorizationUrl: 'javascript:alert(1)',
            expiresAt: BigInt(Date.now() + 60_000),
          }),
        }),
      ListUpstreams: () => create(ListUpstreamsResponseSchema, { upstreams: [] }),
    })

    renderWithClient({
      client,
      children: <LoginDialog open loginId='login-1' onOpenChange={() => {}} />,
    })

    const text = await screen.findByText('javascript:alert(1)')
    const anchor = text.closest('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBeNull()
  })
})

describe('用量页的时间窗白名单', () => {
  it('认得的留着，认不得的当没给', () => {
    expect(usageWindowOf('week')).toBe('week')
    expect(usageWindowOf('today')).toBe('today')
    expect(usageWindowOf('all')).toBe('all')
    expect(usageWindowOf('year')).toBeUndefined()
    expect(usageWindowOf(7)).toBeUndefined()
    expect(usageWindowOf(undefined)).toBeUndefined()
  })
})

describe('用量页的下拉选项没取到', () => {
  it('Provider 列表加载失败：明说并给重试，不悄悄只剩「全部」', async () => {
    window.history.replaceState(null, '', '/usage')
    let upstreamCalls = 0
    const client = mockAdminClient({
      ListUpstreams: () => {
        upstreamCalls++
        throw new ConnectError('炸了', Code.Internal)
      },
      GetUsageSummary: () => create(GetUsageSummaryResponseSchema, {}),
      ListUsageEvents: () => create(ListUsageEventsResponseSchema, { events: [] }),
    })
    const queryClient = makeTestQueryClient()
    const router = createAppRouter(queryClient)
    render(
      <QueryClientProvider client={queryClient}>
        <AdminClientProvider client={client}>
          <RouterProvider router={router} />
        </AdminClientProvider>
      </QueryClientProvider>
    )

    expect(
      await screen.findByText(/Provider 列表加载失败/, undefined, { timeout: 5000 })
    ).toBeInTheDocument()
    const before = upstreamCalls
    const user = userEvent.setup({ delay: null })
    const alert = screen.getByText(/Provider 列表加载失败/).closest('[role="alert"]') as HTMLElement
    await user.click(alert.querySelector('button') as HTMLElement)
    await waitFor(() => expect(upstreamCalls).toBeGreaterThan(before))
    window.history.replaceState(null, '', '/')
  })
})

describe('登录方式取不到', () => {
  it('上游页给出提示与重新获取，而不是悄悄不给「API Key」入口', async () => {
    const user = userEvent.setup({ delay: null })
    let kindsCalls = 0
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qiniu',
              kind: 'qiniu',
              label: '七牛云',
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              accounts: [
                create(AccountSchema, { id: 'qiniu', platform: 'qiniu', alias: '七牛一', enabled: true }),
              ],
            }),
          ],
        }),
      ListProviderKinds: () => {
        kindsCalls++
        throw new ConnectError('炸了', Code.Internal)
      },
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () => create(ListCredentialsResponseSchema, { credentials: [] }),
      GetBenefitStatus: () => {
        throw new ConnectError('不关心', Code.Unimplemented)
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    expect(
      await screen.findByText('平台的登录方式没取到，「API Key」入口暂时不显示')
    ).toBeInTheDocument()
    const before = kindsCalls
    await user.click(screen.getByRole('button', { name: '重新获取' }))
    await waitFor(() => expect(kindsCalls).toBeGreaterThan(before))
  })
})
