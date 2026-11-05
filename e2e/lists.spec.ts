import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { editor, openFile } from './helpers'

const markers = (page: Page, type: string): Promise<string[]> =>
  page.evaluate(
    (t) =>
      [...document.querySelectorAll(`.bn-editor .bn-block-content[data-content-type="${t}"]`)].map(
        (el) => getComputedStyle(el, '::before').content
      ),
    type
  )

/** How far a child block starts left of its parent's text; Notion puts it 6px before. */
const childOffset = (page: Page, parent: string, child: string): Promise<number> =>
  page.evaluate(
    ([parent, child]) => {
      const left = (selector: string, text: string): number =>
        [...document.querySelectorAll(`.bn-editor ${selector}`)]
          .find((e) => e.textContent === text)!
          .getBoundingClientRect().left
      return (
        Math.round(left('.bn-inline-content', parent)) -
        Math.round(left('.bn-block-content', child))
      )
    },
    [parent, child]
  )

test('list markers change with depth, keep their start and sit in a 24px column like Notion', async ({
  nbWith
}) => {
  const { page } = await openFile(
    nbWith,
    'Lists',
    '- b1\n  - b2\n    - b3\n      - b4\n\n' +
      '1. n1\n2. n2\n   1. n3\n   2. n4\n      1. n5\n\nbreak\n\n3. n6\n4. n7\n'
  )
  await expect
    .poll(() => markers(page, 'bulletListItem'), 'bullets change shape with depth and repeat')
    .toEqual(['"•"', '"◦"', '"▪"', '"•"'])
  await expect
    .poll(() => markers(page, 'numberedListItem'), 'numbers go 1. a. i. and keep their start')
    .toEqual(['"1."', '"2."', '"a."', '"b."', '"i."', '"3."', '"4."'])
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = getComputedStyle(
          document.querySelector('.bn-editor [data-content-type="bulletListItem"]')!,
          '::before'
        )
        return [s.width, s.fontSize, s.marginLeft, s.marginRight]
      })
    )
    .toEqual(['24px', '24px', '2px', '6px'])
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.bn-editor .bn-block-outer')].every(
            (el) => getComputedStyle(el, '::before').borderLeftStyle === 'none'
          )
        ),
      'nested blocks have no guide line'
    )
    .toBe(true)
  await expect.poll(() => childOffset(page, 'b1', 'b2'), 'a child lines up under the text').toBe(6)
})

test('to-dos and toggles are drawn like Notion', async ({ nbWith }) => {
  const { page } = await openFile(
    nbWith,
    'Todos',
    '- [ ] open\n  - under task\n- [x] done\n\n<details>\n<summary>Open me</summary>\n\n</details>\n'
  )
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('.bn-editor [data-content-type="checkListItem"] input')].map(
          (el) => {
            const s = getComputedStyle(el)
            return [s.appearance, s.width, s.height, s.backgroundColor]
          }
        )
      )
    )
    .toEqual([
      ['none', '16px', '16px', expect.any(String)],
      ['none', '16px', '16px', 'rgb(39, 131, 222)']
    ])
  await expect(
    page.locator(`${editor} [data-checked="true"] .bn-inline-content`, { hasText: 'done' })
  ).toHaveCSS('opacity', '0.7')
  await expect(
    page.locator(`${editor} [data-checked="true"] .bn-inline-content`, { hasText: 'done' })
  ).toHaveCSS('text-decoration-line', 'line-through')
  await expect
    .poll(() => childOffset(page, 'open', 'under task'), 'a child lines up under the to-do text')
    .toBe(6)
  await page.locator(`${editor} .bn-toggle-button`).click()
  await expect(page.locator(`${editor} .bn-toggle-add-block-button`)).toHaveText(
    'Empty toggle. Click or drop blocks inside.'
  )
})
