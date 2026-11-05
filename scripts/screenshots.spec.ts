import { expect, test } from '../e2e/fixtures'
import { menu, openFile } from '../e2e/helpers'

// A tool, not a test: writes PNGs to compare with Notion by eye. Run with `pnpm screenshots`.

const SAMPLE = `---
id: 11111111-1111-4111-8111-111111111111
icon: 🚀
---

Plan the **website redesign** with *clear* goals and a <span data-bg="yellow">highlighted</span> note.

## Goals

- [x] Audit the current site
- [ ] Draft the new structure
- Ship a <span data-color="red">faster</span> homepage

> [!callout] 💡
> Remember to involve design early.

<details>
<summary>Open questions</summary>

1. Which CMS?

</details>

| Phase | Owner |
| - | - |
| Research | Dale |

\`\`\`ts
const launch = new Date('2027-01-15')
\`\`\`

> Simplicity is the ultimate sophistication.
`

test('reference screenshots in light and dark', async ({ nbWith }) => {
  const { page, app } = await openFile(nbWith, 'Website Redesign', SAMPLE)
  await expect(page.locator('.bn-editor')).toContainText('Simplicity')
  await page.screenshot({ path: 'test-results/reference-light.png' })
  await menu(app, 'Toggle Dark Mode')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: 'test-results/reference-dark.png' })
})
