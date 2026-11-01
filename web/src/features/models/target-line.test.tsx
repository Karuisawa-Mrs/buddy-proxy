import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  ListPublishedModelsResponseSchema,
  PublishedModelSchema,
  PublishedTargetSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PublishedModelsPage } from '@/features/models/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 接不了的目标：名字后面跟一个红框徽标。
 *
 * 表格单元格是 whitespace-nowrap，名字不放开换行时长名字溢出定宽框，徽标压在
 * 名字后半截上。jsdom 不做布局，这里只断言结构与 className：名字与徽标是同一个
 * flex-wrap 容器里的兄弟，徽标不收缩，名字允许换行。
 */
describe('主路由模型的目标行', () => {
  it('长名字标红时，徽标换行而不是压在名字上', async () => {
    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [
            create(PublishedModelSchema, {
              id: 'buddy',
              displayName: 'buddy',
              enabled: true,
              published: true,
              targets: [
                create(PublishedTargetSchema, {
                  groupName: 'workbuddy-global',
                  upstreamModel: 'deepseek-v4.1-flash-with-a-very-long-suffix',
                  weight: 1,
                  enabled: true,
                  blocked: true,
                  blockedReason: '冷却到 02:23 (rate-limit)',
                }),
              ],
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    const badge = await screen.findByText(/接不了：冷却到 02:23 \(rate-limit\)/)
    const name = screen.getByText(
      'workbuddy-global → deepseek-v4.1-flash-with-a-very-long-suffix'
    )

    const line = badge.parentElement!
    expect(line).toBe(name.parentElement)
    expect(line.dataset.testid).toBe('target-line')
    expect(line.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex', 'flex-wrap'])
    )

    // 徽标在名字后面，且不被压缩。
    expect(name.nextElementSibling).toBe(badge)
    expect(badge.className.split(/\s+/)).toContain('shrink-0')

    // 名字盖过单元格的 nowrap，长了就换行。
    const nameClasses = name.className.split(/\s+/)
    expect(nameClasses).toEqual(
      expect.arrayContaining(['whitespace-normal', 'break-all', 'min-w-0'])
    )
    expect(nameClasses).not.toContain('whitespace-nowrap')

    // 颜色语义不变：接不了的名字仍是红的。
    expect(nameClasses).toContain('text-red-600')
  })
})
