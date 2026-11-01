import { createFileRoute } from '@tanstack/react-router'
import { UsagePage } from '@/features/usage'
import { usageWindowOf } from '@/features/usage/windows'

/**
 * 用量页面的筛选和分页都写在 URL 里：刷新和分享链接都保得住状态。
 */
export const Route = createFileRoute('/_authenticated/usage')({
  validateSearch: (search: Record<string, unknown>) => ({
    page: typeof search.page === 'number' ? search.page : undefined,
    pageSize: typeof search.pageSize === 'number' ? search.pageSize : undefined,
    q: typeof search.q === 'string' ? search.q : undefined,
    // 上游和模型的 id 有可能是纯数字，查询串解析成数字了，这里拉回字符串。
    upstream:
      search.upstream === undefined || search.upstream === null
        ? undefined
        : String(search.upstream),
    model:
      search.model === undefined || search.model === null
        ? undefined
        : String(search.model),
    // 时间窗：只认下拉里有的那几档。手改出来的值（或旧链接里的）落回默认，
    // 不然下拉显示空白，后端也按一个不认识的窗口去算。
    window: usageWindowOf(search.window),
  }),
  component: UsagePage,
})
