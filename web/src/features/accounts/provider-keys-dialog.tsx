import { useState } from 'react'
import { KeyRound, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/** 账号上已经有的一段凭据：只有掩码，不回显全文。 */
export type ExistingKey = {
  /** api_key / cookie。 */
  kind: string
  masked: string
}

/**
 * 按段提交的内容。
 *
 * 没填的段是 undefined —— 后端只覆盖给了值的那一段，留空就是「不改」。
 * 清掉凭据不走这里，走 onClear（要二次确认）。
 */
export type ProviderKeysInput = {
  apiKey?: string
  portalCookie?: string
  /** 一行一把 key 的那种（按位置写）。 */
  keys?: string[]
}

/**
 * 写 API Key 的弹窗。
 *
 * 一行一把 key 的那种：第一把是第一个租户，留空的行会被丢掉。
 *
 * 七牛云是两段：推理用的 API Key，加上只用来查额度的门户 cookie。讯飞星火只有
 * 一把推理用的 API Key。这两家按段写：留空的段不改，两段都空就不能保存 ——
 * 空着点保存不该把已有的凭据抹掉。要清掉凭据点「清除凭据」，再确认一次。
 */
export function ProviderKeysDialog({
  open,
  onOpenChange,
  existing,
  onSubmit,
  onClear,
  pending,
  /** 这把 key 是干什么的：开放平台是租户的 key。 */
  kind,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 账号上已经有的凭据（掩码后的），只用来提示，不回显。 */
  existing: ExistingKey[]
  onSubmit: (input: ProviderKeysInput) => void
  /** 清掉这个账号的全部 key。没给就不出「清除」入口。 */
  onClear?: () => void
  pending: boolean
  kind?: string
}) {
  const [text, setText] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [cookie, setCookie] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const isQiniu = kind === 'qiniu'
  const isXinghuo = kind === 'xinghuo'
  const byParts = isQiniu || isXinghuo

  const keys = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const trimmedKey = apiKey.trim()
  const trimmedCookie = cookie.trim()
  // 空值不能保存：按段写时至少要有一段，按位置写时至少要有一把。
  const empty = byParts
    ? !trimmedKey && !(isQiniu && trimmedCookie)
    : keys.length === 0

  const existingKey = existing.find((row) => row.kind === 'api_key')
  const existingCookie = existing.find((row) => row.kind === 'cookie')

  const reset = () => {
    setText('')
    setApiKey('')
    setCookie('')
  }

  const submit = () => {
    if (empty) return
    if (!byParts) {
      onSubmit({ keys })
      return
    }
    onSubmit({
      ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      ...(isQiniu && trimmedCookie ? { portalCookie: trimmedCookie } : {}),
    })
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) reset()
          onOpenChange(next)
        }}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2'>
              <KeyRound className='size-4' />
              {isQiniu
                ? '七牛云凭据'
                : isXinghuo
                  ? '讯飞星火 API Key'
                  : 'API Key'}
            </DialogTitle>
            <DialogDescription>
              {isQiniu ? (
                <>
                  推理 API Key 用来发模型请求；门户 Cookie 只用于查询资源包额度，可留空。在
                  portal.qiniu.com 登录后从浏览器复制 Cookie，整串粘贴。留空的一段保持不变。
                </>
              ) : isXinghuo ? (
                <>在讯飞星火控制台创建 API Key，整串粘贴。留空就是不改</>
              ) : (
                <>
                  一行一把 key，按顺序排：第一把是第一个租户。填了 key 的租户会轮着接手请求，接不了的（套餐用完、被拒、被限流）就换下一把。
                  {existing.length > 0
                    ? ` 现在有 ${existing.length} 把，保存后会被这里填的替换。`
                    : ''}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {byParts ? (
            <div className='grid gap-3'>
              <div className='grid gap-2'>
                <Label htmlFor='provider-api-key'>
                  {isQiniu ? '推理 API Key' : 'API Key'}
                </Label>
                <Input
                  id='provider-api-key'
                  type='password'
                  placeholder={
                    existingKey
                      ? `现在是 ${existingKey.masked}，留空不改`
                      : isQiniu
                        ? 'sk-…'
                        : '在讯飞星火控制台复制的 API Key'
                  }
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className='font-mono text-xs'
                  autoComplete='off'
                />
              </div>
              {isQiniu ? (
                <div className='grid gap-2'>
                  <Label htmlFor='qiniu-cookie'>门户 Cookie</Label>
                  <Input
                    id='qiniu-cookie'
                    type='password'
                    placeholder={
                      existingCookie
                        ? `现在是 ${existingCookie.masked}，留空不改`
                        : 'c=…'
                    }
                    value={cookie}
                    onChange={(event) => setCookie(event.target.value)}
                    className='font-mono text-xs'
                    autoComplete='off'
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <div className='grid gap-2'>
              <Label htmlFor='provider-keys'>key（每行一把）</Label>
              <Textarea
                id='provider-keys'
                rows={5}
                placeholder='sk-cp-…'
                value={text}
                onChange={(event) => setText(event.target.value)}
                className='font-mono text-xs'
                autoComplete='off'
              />
            </div>
          )}
          <DialogFooter className='sm:justify-between'>
            {onClear && existing.length > 0 ? (
              <Button
                variant='destructive'
                disabled={pending}
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 />
                清除凭据
              </Button>
            ) : (
              <span />
            )}
            <div className='flex gap-2'>
              <Button
                variant='outline'
                onClick={() => {
                  reset()
                  onOpenChange(false)
                }}
              >
                取消
              </Button>
              <Button disabled={pending || empty} onClick={submit}>
                保存
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清除是危险操作：凭据删掉就没了，推理也会停。再确认一次。 */}
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清除这个账号的凭据</AlertDialogTitle>
            <AlertDialogDescription>
              账号上的 {existing.length} 段凭据会全部删掉，删完这个账号就发不了请求，回不来，只能重新填。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                setConfirmClear(false)
                onClear?.()
              }}
            >
              清除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
