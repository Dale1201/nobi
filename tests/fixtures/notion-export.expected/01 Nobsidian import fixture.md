This page is a test fixture for Nobsidian's Notion importer. It covers every block type, color and special case.

# Heading 1

## Heading 2

### Heading 3

#### Heading 4

## Inline styles

Plain, **bold**, *italic*, <u>underline</u>, ~~strike~~, `inline code`, [a link](https://example.com), **_bold italic_**, **bold with** `code` and inline math $E = mc^2$ in one paragraph.

First line of a paragraph\
second line after a hard line break.

&nbsp;

The empty paragraph above is intentional.

## Text colors

<span data-color="gray">gray</span> <span data-color="brown">brown</span> <span data-color="orange">orange</span> <span data-color="yellow">yellow</span> <span data-color="green">green</span> <span data-color="blue">blue</span> <span data-color="purple">purple</span> <span data-color="pink">pink</span> <span data-color="red">red</span>

## Highlights

<span data-bg="gray">gray</span> <span data-bg="brown">brown</span> <span data-bg="orange">orange</span> <span data-bg="yellow">yellow</span> <span data-bg="green">green</span> <span data-bg="blue">blue</span> <span data-bg="purple">purple</span> <span data-bg="pink">pink</span> <span data-bg="red">red</span>

Mixed: **<span data-color="red">bold red</span>** and <u><span data-bg="yellow">underlined on yellow</span></u>.

## Block colors

A paragraph with blue text.<!-- color=blue -->

A paragraph with a yellow background.<!-- bg=yellow -->

### A heading with a purple background<!-- bg=purple -->

- A red list item<!-- color=red -->

## Lists

- Bullet one
- Bullet two
  - Nested bullet
    - Third level bullet
- Bullet three

1. Number one
2. Number two
   1. Nested number
      1. Third level number
3. Number three

- [ ] Unchecked to-do
- [x] Checked to-do
  - [ ] Nested to-do
    - [x] Third level to-do

## Toggles

<details>
<summary>A toggle</summary>

Hidden paragraph inside the toggle.

- A bullet inside the toggle

</details>

<details data-heading="1">
<summary>Toggle heading 1</summary>

Content under toggle heading 1.

</details>

<details data-heading="2">
<summary>Toggle heading 2</summary>

Content under toggle heading 2.

</details>

<details data-heading="3">
<summary>Toggle heading 3</summary>

Content under toggle heading 3.

</details>

## Quote and callouts

> A plain quote.

> A quote with a green background<!-- bg=green -->
>
> A child paragraph inside the quote.

> [!callout] 💡
> A default callout
>
> - A bullet inside the callout

> [!callout:orange_bg] 🚧
> An orange callout with a custom icon

---

## Code

```tsx
export function greet(name: string): string {
  return `Hello, ${name}`
}
```

```python
def greet(name):
    return f"Hello, {name}"
```

## Equation

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

## Tables

| Name  | Role     | Score |
| ----- | -------- | ----- |
| Ada   | Engineer | 10    |
| Grace | Admiral  | 9     |

| Fruit  | Color  | Price           |
| ------ | ------ | --------------- |
| Apple  | Red    | 1.20            |
| Banana | Yellow | 0.50<br>on sale |

## Table of contents

<nav data-toc></nav>

## Media

![An uploaded image with a caption](nobi-import:file/2)

![An external image](nobi-import:file/3)

[fixture-report.pdf](nobi-import:file/4 "file")

## Columns

<div data-columns>

<div data-column>

Left column, half width.

- A list in the left column

</div>

<div data-column>

Right column, half width.

</div>

</div>

<div data-columns>

<div data-column data-width="0.6">

Narrow column.

</div>

<div data-column data-width="1.5">

<details>
<summary>Toggle inside a column</summary>

- List inside a toggle inside a column
  - Nested deeper

</details>

</div>

<div data-column data-width="0.9">

Third column.

</div>

</div>

## Bookmark and embed

<https://www.wikipedia.org>

<https://www.youtube.com/watch?v=aqz-KE-bpKQ>

## Synced block

This text lives in a synced block.

## Links and mentions

A page mention: [Grandchild page](notion://4007c9e82e0e81e79ed6d9a0bd0123a7).

A plain link to a sub-page: [go to the child page](notion://4007c9e82e0e81f7b102df32904f66ba).

A mention of a database row: [The Left Hand of Darkness](notion://4007c9e82e0e814c960cdf7fcf4b6a9e).

A date mention: @October 22, 2026 and a date range: @November 1, 2026 → November 3, 2026.

A person mention: @Ada Lovelace.

## Sub-pages and database

[4007c9e82e0e81f7b102df32904f66ba](notion://4007c9e82e0e81f7b102df32904f66ba "page")

[4007c9e82e0e8127999ee63ec39055a2](notion://4007c9e82e0e8127999ee63ec39055a2 "page")

[4007c9e82e0e81c983d1d6f04440ece4](notion://4007c9e82e0e81c983d1d6f04440ece4 "page")

[4007c9e82e0e819d9747ccfbcf815c24](notion://4007c9e82e0e819d9747ccfbcf815c24 "page")

[9a60be708a6d4a328b6fffd32be620c2](notion://9a60be708a6d4a328b6fffd32be620c2 "page")
