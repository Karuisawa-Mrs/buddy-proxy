import { create } from '@bufbuild/protobuf'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { GetBalanceRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { describeError } from '@/lib/errors'

export const balanceKeys = {
  /** 额度的所有查询：刷新时按这个前缀失效，平台列表变了也不会漏掉谁。 */
  root: ['balance'] as const,
  all: (upstreamId: string) => ['balance', upstreamId] as const,
}

/**
 * 首屏：只读快照（peek），不等后端的全量刷新。
 *
 * 回来的是快照里已有的数，加上名下有账号的平台列表 —— 页面据此先把已有的数
 * 画出来，再按平台各问一趟现数。最慢的平台不拖整页。
 */
export function useBalanceOverview() {
  const client = useAdminClient()
  return useQuery({
    queryKey: balanceKeys.all(''),
    queryFn: () =>
      client.getBalance(
        create(GetBalanceRequestSchema, { upstreamId: '', peek: true })
      ),
  })
}

/**
 * 按平台各问一趟额度，谁先回来谁先渲染。
 *
 * 查询按平台发（upstream_id 是平台 id），回来的每一条是一个账号：页面按账号
 * 画卡。慢的那家只是它自己那几张卡慢着。
 */
export function useBalances(upstreamIds: string[]) {
  const client = useAdminClient()
  return useQueries({
    queries: upstreamIds.map((upstreamId) => ({
      queryKey: balanceKeys.all(upstreamId),
      queryFn: () =>
        client.getBalance(create(GetBalanceRequestSchema, { upstreamId })),
    })),
  })
}

/**
 * 「刷新额度」：现在就去问一趟上游。
 *
 * 为什么不用查询上的 force 参数：那种查询一挂载就发请求，每次打开面板都会
 * 去问一轮上游。强制刷新是用户点了按钮才做的事，所以走 mutation。
 *
 * 先停掉在飞的额度查询（它们拿回来的是刷新前的数，晚到会把新数盖掉），刷完
 * 按 ['balance'] 前缀整体失效：平台列表是现在的，不是闭包里那份旧的。
 */
export function useRefreshBalance() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries({ queryKey: balanceKeys.root })
      return client.getBalance(
        create(GetBalanceRequestSchema, { upstreamId: '', force: true })
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: balanceKeys.root })
      toast.success('额度已刷新')
    },
    onError: (error) => {
      toast.error(describeError(error))
    },
  })
}
