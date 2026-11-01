import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 额度的查询键前缀（features/balance/api.ts 里的 balanceKeys.root）。 */
const BALANCE_ROOT = 'balance'

/**
 * 手动刷新。面板不自动重取（refetchOnWindowFocus 关着），总得有个地方
 * 能让用户自己按一下。
 *
 * 额度不在这里刷：每家额度查询都会去问一趟上游（上游额度小，问多了会被
 * 限流），要现数请用额度页上的「刷新额度」。
 */
export function RefreshButton() {
  const queryClient = useQueryClient()
  // 转圈与禁用只看这个按钮管的那些查询：额度页上各家额度慢慢回来时，这个
  // 按钮不该跟着一直转、一直按不了。
  const fetching =
    useIsFetching({
      predicate: (query) => query.queryKey[0] !== BALANCE_ROOT,
    }) > 0

  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label='刷新'
      title='刷新'
      disabled={fetching}
      onClick={() => {
        void queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] !== BALANCE_ROOT,
        })
      }}
    >
      <RefreshCw className={cn('size-4', fetching && 'animate-spin')} />
    </Button>
  )
}
