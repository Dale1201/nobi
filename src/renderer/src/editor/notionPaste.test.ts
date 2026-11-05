import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@shared/core/blocks'
import { blocksToMarkdown } from '@shared/core/serialize'

const invoke = vi.hoisted(() => {
  const fn = vi.fn()
  ;(globalThis as { window?: unknown }).window = { api: { invoke: fn } }
  return fn
})

const { prepareNotionPaste } = await import('./notionPaste')

const PLAN = '0123456789abcdef0123456789abcdef'
const DASHED = 'fedcba98-7654-3210-fedc-ba9876543210'
const OTHER = '99999999999999999999999999999999'

const html = (body: string): string => `<!-- notionvc: 1 -->${body}`

beforeEach(() => {
  invoke.mockReset()
})

describe('prepareNotionPaste', () => {
  it('points links at pages imported earlier and keeps the others', async () => {
    invoke.mockResolvedValue({ [PLAN]: 'plan-id', fedcba9876543210fedcba9876543210: 'spec-id' })
    const { blocks } = await prepareNotionPaste({
      html: html(
        `<p><a href="https://www.notion.so/Plan-${PLAN}?pvs=4">Plan</a> ` +
          `<a href="/x" data-notion-page-id="${DASHED}">Spec</a> ` +
          `<a href="https://www.notion.so/Old-${OTHER}">Old</a></p>`
      )
    })
    expect(invoke).toHaveBeenCalledWith('notion:pages', {
      notionIds: [PLAN, 'fedcba9876543210fedcba9876543210', OTHER]
    })
    expect(blocksToMarkdown(blocks)).toBe(
      `[Plan](nobsidian://page/plan-id) [Spec](nobsidian://page/spec-id) [Old](https://www.notion.so/Old-${OTHER})\n`
    )
  })

  it('keeps Notion links when looking up imported pages fails', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('no workspace')
    })
    const { blocks } = await prepareNotionPaste({
      html: html(`<p><a href="https://www.notion.so/Plan-${PLAN}">Plan</a></p>`)
    })
    expect(blocksToMarkdown(blocks)).toBe(`[Plan](https://www.notion.so/Plan-${PLAN})\n`)
  })

  it('asks the app for nothing when the copy names no Notion page', async () => {
    const { blocks } = await prepareNotionPaste({ html: html('<p>Plain</p>') })
    expect(invoke).not.toHaveBeenCalled()
    expect(blocksToMarkdown(blocks)).toBe('Plain\n')
  })

  it('counts files uploaded to Notion, and no other issue', async () => {
    const records = JSON.stringify({
      blocks: ['a', 'b', 'c'].map((id, i) => ({
        blockId: id,
        blockSubtree: {
          __version__: 3,
          block: {
            [id]: {
              value:
                i < 2
                  ? {
                      id,
                      type: 'image',
                      properties: { source: [[`attachment:${id}:${id}.png`]] }
                    }
                  : { id, type: 'unknown_kind' }
            }
          }
        }
      }))
    })
    const { uploads } = await prepareNotionPaste({ records })
    expect(uploads).toBe(2)
  })
})

describe('web images in a Notion paste', () => {
  const figure = (src: string, caption = ''): string =>
    `<figure class="image"><img src="${src}"><figcaption>${caption}</figcaption></figure>`

  it('downloads web images, nested ones too, and links the ones it cannot fetch', async () => {
    const { blocks, images } = await prepareNotionPaste({
      html: html(
        figure('https://a.example/ok.png', 'Ok') +
          figure('attachments/local.png') +
          `<details><summary>More</summary><div class="indented">${figure('HTTP://a.example/cap.png', 'Chart')}</div></details>`
      )
    })
    expect(images.map((i) => i.id)).toEqual([blocks[0].id, blocks[2].children[0].id])
    invoke.mockImplementation(async (_channel: string, { url }: { url: string }) => {
      if (url.endsWith('ok.png')) return 'attachments/ok.png'
      throw new Error('blocked')
    })
    const updates = await Promise.all(images.map((i) => i.download()))
    expect(blocksToMarkdown(updates.map((u) => ({ ...u, children: [] }) as Block))).toBe(
      '![Ok](attachments/ok.png)\n\n[Chart](HTTP://a.example/cap.png)\n'
    )
  })
})
