import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import {
  clearToken,
  getToken,
  subscribeToken,
} from '@/features/auth/token-store'
import { isAuthError } from '@/lib/errors'

/**
 * 面板的 QueryClient。
 *
 * 401 一律不重试：令牌不对的时候重试只会把面板刷满错误。别的错误重试
 * 两次，因为网关可能正在重启。
 */
export function createQueryClient(): QueryClient {
  const client = new PanelQueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (isAuthError(error)) return false
          return failureCount < 2
        },
        refetchOnWindowFocus: false,
        staleTime: 10_000,
      },
      mutations: {
        retry: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        // 令牌过期或者被换掉了：把面板送回令牌输入页。
        if (isAuthError(error)) {
          clearToken()
        }
      },
    }),
    // mutation 上的 401 也要清令牌：QueryCache 只管 query，mutation 走
    // MutationCache。少了这一段，令牌过期后用户会卡在一个「看起来正常
    // 但什么都不对」的页面上。
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isAuthError(error)) {
          clearToken()
        }
      },
    }),
  })
  return client
}

/**
 * 带着「令牌变了就清缓存」的 QueryClient。
 *
 * 订阅跟着 client 的生命走：建出来就订上（没挂到 Provider 上也照样清），
 * Provider 全部卸下时退订，再挂上时重新订。退订函数存在实例上，不会丢 ——
 * 丢了的话，每建一个 client 就在令牌仓库里多留一个永远退不掉的监听。
 */
class PanelQueryClient extends QueryClient {
  #mounts = 0
  #stopTokenWatch: (() => void) | null = clearCacheOnTokenChange(this)

  override mount(): void {
    super.mount()
    this.#mounts++
    this.#stopTokenWatch ??= clearCacheOnTokenChange(this)
  }

  override unmount(): void {
    super.unmount()
    this.#mounts = Math.max(0, this.#mounts - 1)
    if (this.#mounts === 0) {
      this.#stopTokenWatch?.()
      this.#stopTokenWatch = null
    }
  }
}

/**
 * 令牌变了（清掉、过期 401、换了一个）就把缓存清空。
 *
 * 缓存里是上一个令牌拿到的东西：凭据掩码、账号、额度。留着它，下一个人填进
 * 令牌时会先看到上一份数据；令牌被拒之后它也还在内存里。
 */
export function clearCacheOnTokenChange(client: QueryClient): () => void {
  let last = getToken()
  return subscribeToken(() => {
    const next = getToken()
    if (next === last) return
    last = next
    client.clear()
  })
}
