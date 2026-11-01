import { Button } from '@/components/ui/button'

/**
 * 平台的登录方式（ListProviderKinds）没取到。
 *
 * 「API Key」入口是照登录方式给的：取不到它，入口就悄悄没了，用户只会以为
 * 这个平台不收 key。所以要明说，并给一个重新获取。
 */
export function KindsErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role='alert'
      className='flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2'
    >
      <p className='text-sm text-destructive'>
        平台的登录方式没取到，「API Key」入口暂时不显示
      </p>
      <Button variant='outline' size='sm' onClick={onRetry}>
        重新获取
      </Button>
    </div>
  )
}
