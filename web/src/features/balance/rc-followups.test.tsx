import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import {
  AccountSchema,
  CredentialSchema,
  CreditSummarySchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListProviderKindsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderKindSchema,
  ProviderPolicy,
  SetProviderKeysResponseSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import { QuotaCard } from '@/features/balance/cards'
import { UpstreamsPage } from '@/features/upstreams/index'
import { RefreshButton } from '@/components/layout/refresh-button'
import { setToken } from '@/features/auth/token-store'
import { createQueryClient } from '@/lib/query-client'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
}))

function quotaWith(init: { error?: string; stale?: boolean }) {
  return create(UpstreamQuotaSchema, {
    upstreamId: 'qoder',
    accountId: 'qoder-1',
    credits: create(CreditSummarySchema, { total: 100, used: 30, remaining: 70 }),
    ...init,
  })
}

describe('额度卡：「上一次的数」看契约里的 stale', () => {
  it('stale：说是上一次的数', () => {
    render(<QuotaCard quota={quotaWith({ error: 'HTTP 500', stale: true })} />)
    expect(screen.getByText(/下面是上一次的数：HTTP 500/)).toBeInTheDocument()
  })

  it('有数也有错误，但不是 stale：不说成旧数', () => {
    render(<QuotaCard quota={quotaWith({ error: '部分没问到', stale: false })} />)
    expect(screen.queryByText(/上一次的数/)).not.toBeInTheDocument()
    expect(screen.getByText(/这个账号的额度没问到：部分没问到/)).toBeInTheDocument()
  })
})

/** 一个平台带一个账号；凭据表由用例给。 */
function upstreamsClient(
  kind: string,
  credentials: { kind: string; masked: string }[],
  sent: string[] = []
) {
  const account = create(AccountSchema, {
    id: `${kind}-1`,
    platform: kind,
    alias: '一号',
    enabled: true,
    status: 'usable',
    credentialCount: credentials.length,
  })
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [
          create(UpstreamSchema, {
            id: kind,
            kind,
            label: kind,
            state: UpstreamState.NO_CREDENTIAL,
            policy: ProviderPolicy.SINGLE,
            policies: [ProviderPolicy.SINGLE],
            accountCount: 1,
            accounts: [account],
          }),
        ],
      }),
    ListProviderKinds: () =>
      create(ListProviderKindsResponseSchema, {
        kinds: [create(ProviderKindSchema, { kind, login: 'api_key' })],
      }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [account] }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, {
        credentials: credentials.map((row, i) =>
          create(CredentialSchema, {
            id: `c${i}`,
            accountId: account.id,
            kind: row.kind,
            masked: row.masked,
          })
        ),
      }),
    SetProviderKeys: (input) => {
      sent.push(input.clear ? '<clear>' : (input.apiKey ?? '-'))
      return create(SetProviderKeysResponseSchema, { ok: true })
    },
  })
}

async function openKeys(kind: string) {
  const user = userEvent.setup({ delay: null })
  await user.click(
    await screen.findByRole('button', { name: `展开 ${kind} 的账号与凭据` })
  )
  await user.click(await screen.findByRole('button', { name: 'API Key' }))
  return user
}

describe('填 key 弹窗：只讲 key 与 cookie', () => {
  it('星火：账号上只有会话行，不算有凭据（不给「清除凭据」）', async () => {
    renderWithClient({
      client: upstreamsClient('xinghuo', [{ kind: 'session', masked: 'dt-…' }]),
      children: <UpstreamsPage />,
    })
    await openKeys('xinghuo')
    expect(await screen.findByText('讯飞星火 API Key')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清除凭据' })).not.toBeInTheDocument()
  })

  it('星火：有 api_key 行就给「清除凭据」，占位显示的是 key 的掩码', async () => {
    renderWithClient({
      client: upstreamsClient('xinghuo', [
        { kind: 'session', masked: 'dt-…' },
        { kind: 'api_key', masked: 'sk-a…' },
      ]),
      children: <UpstreamsPage />,
    })
    await openKeys('xinghuo')
    expect(
      await screen.findByPlaceholderText('现在是 sk-a…，留空不改')
    ).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '清除凭据' })).toBeInTheDocument()
  })

  it('不是七牛 / 星火：有 key 也不给「清除凭据」（后端的 clear 不认它）', async () => {
    renderWithClient({
      client: upstreamsClient('custom', [{ kind: 'api_key', masked: 'sk-b…' }]),
      children: <UpstreamsPage />,
    })
    await openKeys('custom')
    expect(await screen.findByLabelText('key（每行一把）')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清除凭据' })).not.toBeInTheDocument()
  })
})

describe('全局刷新按钮：额度在刷的时候不跟着转', () => {
  it('只有额度的查询在飞：按钮能点', async () => {
    const queryClient = new QueryClient()
    // 额度的那一趟一直不回来。
    void queryClient.prefetchQuery({
      queryKey: ['balance', 'qoder'],
      queryFn: () => new Promise<never>(() => {}),
    })
    renderWithClient({
      client: mockAdminClient({}),
      queryClient,
      children: <RefreshButton />,
    })
    await waitFor(() => {
      expect(queryClient.isFetching({ queryKey: ['balance'] })).toBe(1)
    })
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })

  it('别的查询在飞：按钮禁用（对照）', async () => {
    const queryClient = new QueryClient()
    void queryClient.prefetchQuery({
      queryKey: ['upstreams'],
      queryFn: () => new Promise<never>(() => {}),
    })
    renderWithClient({
      client: mockAdminClient({}),
      queryClient,
      children: <RefreshButton />,
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    })
  })
})

describe('面板的 QueryClient：令牌监听跟着 client 走', () => {
  afterEach(() => setToken('test-token'))

  it('建好就在监听：换令牌清缓存', () => {
    setToken('t1')
    const client = createQueryClient()
    client.setQueryData(['accounts'], 1)
    setToken('t2')
    expect(client.getQueryData(['accounts'])).toBeUndefined()
    // 退订：挂上再卸下就会退掉，别在令牌仓库里留监听。
    client.mount()
    client.unmount()
  })

  it('卸下之后退订：换令牌不再碰它；再挂上又订回来', () => {
    setToken('t1')
    const client = createQueryClient()
    client.mount()
    client.unmount()
    client.setQueryData(['accounts'], 1)
    setToken('t2')
    expect(client.getQueryData(['accounts'])).toBe(1)

    client.mount()
    setToken('t3')
    expect(client.getQueryData(['accounts'])).toBeUndefined()
    client.unmount()
  })
})
