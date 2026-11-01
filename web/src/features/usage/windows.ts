// 用量页的时间窗。契约里的取值：hour / day / week / month，空表示全部。
// today 是从本地零点算起的一段 —— 早上八点看「今天」，要的是零点到现在。
export const USAGE_WINDOWS = [
  { value: 'today', label: '今日' },
  { value: 'hour', label: '最近一小时' },
  { value: 'day', label: '最近一天' },
  { value: 'week', label: '最近一周' },
  { value: 'month', label: '最近一个月' },
  { value: 'all', label: '全部' },
] as const

const KNOWN = new Set<string>(USAGE_WINDOWS.map((item) => item.value))

/**
 * 查询串里的 window：认得的原样留着，认不得的当没给（页面用默认那一档）。
 *
 * 查询串是用户能手改的，只做 String() 会把任何东西放进去。
 */
export function usageWindowOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw)
  return KNOWN.has(value) ? value : undefined
}
