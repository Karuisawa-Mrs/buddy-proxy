/**
 * 只放行 http / https 的链接。
 *
 * 授权链接是后端转来的上游地址，面板把它放进 <a href>。javascript:、data:
 * 这类地址一点就在面板的源里跑代码 —— 面板手里有管理令牌。认不出来的、
 * 别的协议的，一律不给链接（返回 undefined：<a> 没有 href 就点不动）。
 */
export function safeHttpUrl(raw: string | undefined | null): string | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}
