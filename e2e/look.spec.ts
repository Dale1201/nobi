import { expect, test } from './fixtures'
import { menu, editor, newTab, openFile } from './helpers'

test('headings, links, inline code and dividers look like Notion’s', async ({ nbWith }) => {
  const { page } = await openFile(
    nbWith,
    'Look',
    '# One\n\n## Two\n\n### Three\n\nA [link](https://example.com) and `code`.\n\n---\n'
  )
  const body = page.locator(editor)
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.bn-editor [data-content-type="heading"]')].map(
            (el) => getComputedStyle(el.querySelector('h1, h2, h3') ?? el).fontSize
          )
        ),
      'Notion heading sizes, level 1 included'
    )
    .toEqual(['30px', '24px', '20px'])
  const text = await body
    .locator('p')
    .first()
    .evaluate((el) => getComputedStyle(el).color)
  const link = body.getByRole('link', { name: 'link' })
  await expect(link).toHaveCSS('color', text)
  await expect(link).toHaveCSS('text-decoration-line', 'underline')
  await expect(body.locator('code')).toHaveCSS('color', 'rgb(235, 87, 87)')
  await expect(body.locator('hr')).toHaveCSS('border-top-color', 'rgba(55, 53, 47, 0.16)')
})

test('the tab bar is sized and coloured like Notion’s', async ({ nbWith }) => {
  const nb = await nbWith({ files: { 'One.md': 'One.\n', 'Two.md': 'Two.\n' } })
  const { page } = nb
  await nb.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light'
  })
  await page.getByTestId('sidebar-row-One').click()
  await newTab(nb.app, page)
  await page.getByTestId('sidebar-row-Two').click()
  await page.getByTestId('tab-One').click()
  const bar = page.locator('.tab-bar')
  const active = page.getByTestId('tab-One')
  const inactive = page.getByTestId('tab-Two')
  await expect(bar).toHaveCSS('height', '36px')
  await expect(bar).toHaveCSS('background-color', 'rgb(248, 248, 247)')
  await expect(active).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(inactive).toHaveCSS('background-color', 'rgb(248, 248, 247)')
  await expect(active.locator('.tab-title')).toHaveCSS('font-size', '13px')
  await expect(active.locator('.tab-title')).toHaveCSS('font-weight', '500')
  await expect(inactive.locator('.tab-title')).toHaveCSS('color', 'rgba(55, 53, 47, 0.65)')
  await expect.poll(async () => (await inactive.boundingBox())?.width).toBe(200)
  const inset = await page.evaluate(
    () =>
      (window as unknown as { api: { windowControls: { inset: number } } }).api.windowControls.inset
  )
  await expect(page.locator('.tab-bar-lead')).toHaveCSS('padding-left', `${inset}px`)
  await expect
    .poll(async () => {
      const lead = await page.locator('.tab-bar-lead').boundingBox()
      const sidebar = await page.getByTestId('sidebar').boundingBox()
      return lead && sidebar && lead.width === sidebar.width
    }, 'the tab bar lead is as wide as the sidebar')
    .toBe(true)

  await menu(nb.app, 'Toggle Dark Mode')
  await expect(active).toHaveCSS('background-color', 'rgb(25, 25, 25)')
  await expect(inactive).toHaveCSS('background-color', 'rgb(32, 32, 32)')
})

test('scrollbars are thin rounded thumbs with no track, like Notion’s', async ({ nbWith }) => {
  const files = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`Page ${i}.md`, 'Text.\n'])
  )
  const nb = await openFile(nbWith, 'Long', 'Line.\n\n'.repeat(200), { files })
  const { page } = nb
  await expect(page.locator(editor)).toContainText('Line.')

  const scrollers = { sidebar: page.locator('.sidebar-scroll'), page: page.locator('.page-scroll') }
  const pixel = async (scroller: keyof typeof scrollers, fromRight: number): Promise<number[]> => {
    const box = (await scrollers[scroller].boundingBox())!
    const x = Math.round(box.x + box.width - fromRight)
    const y = Math.round(box.y + 20)
    return nb.app.evaluate(
      async ({ BrowserWindow }, rect) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect)
        const [b, g, r] = image.toBitmap()
        return [r, g, b]
      },
      { x, y, width: 1, height: 1 }
    )
  }
  // A theme switch repaints scrollbars a little after the attribute changes.
  const expectColor = (
    scroller: keyof typeof scrollers,
    fromRight: number,
    expected: number[]
  ): Promise<void> =>
    expect(async () => {
      const actual = await pixel(scroller, fromRight)
      actual.forEach((c, i) => expect(Math.abs(c - expected[i])).toBeLessThanOrEqual(2))
    }).toPass({ timeout: 5000 })

  for (const scroller of Object.values(scrollers)) {
    await expect
      .poll(() => scroller.evaluate((el: HTMLElement) => el.offsetWidth - el.clientWidth))
      .toBe(12)
  }

  await nb.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light'
  })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expectColor('sidebar', 6, [205, 205, 203])
  await expectColor('sidebar', 1, [248, 248, 247])
  await expectColor('page', 6, [211, 211, 209])
  await expectColor('page', 1, [255, 255, 255])

  await menu(nb.app, 'Toggle Dark Mode')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expectColor('sidebar', 6, [81, 81, 81])
  await expectColor('sidebar', 1, [32, 32, 32])
  await expectColor('page', 6, [76, 76, 76])
  await expectColor('page', 1, [25, 25, 25])
})
