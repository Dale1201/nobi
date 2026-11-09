// Plain-JSON mirror of the BlockNote document shape used by Nobi's schema.
// Kept free of runtime imports so main, renderer and tests can share it.

export const COLOR_NAMES = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red'
] as const
export type ColorName = (typeof COLOR_NAMES)[number]

export interface Styles {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  textColor?: string
  backgroundColor?: string
}

export interface StyledText {
  type: 'text'
  text: string
  styles: Styles
}

export interface LinkInline {
  type: 'link'
  href: string
  content: StyledText[]
}

export interface InlineMath {
  type: 'inlineMath'
  props: { latex: string }
}

export interface PageMentionInline {
  type: 'pageMention'
  props: { href: string; title: string }
}

export type Inline = StyledText | LinkInline | InlineMath | PageMentionInline

export interface TableCell {
  type: 'tableCell'
  props?: Record<string, unknown>
  content: Inline[]
}

export interface TableContent {
  type: 'tableContent'
  columnWidths?: (number | undefined)[]
  headerRows?: number
  headerCols?: number
  rows: { cells: (Inline[] | TableCell)[] }[]
}

export interface BlockColors {
  textColor?: string
  backgroundColor?: string
}

interface BlockBase<T extends string, P> {
  id?: string
  type: T
  props: P
  children: Block[]
}

type WithInline<T extends string, P> = BlockBase<T, P> & { content: Inline[] }
type WithoutContent<T extends string, P> = BlockBase<T, P> & { content?: undefined }

export type ParagraphBlock = WithInline<'paragraph', BlockColors>
export type HeadingBlock = WithInline<
  'heading',
  BlockColors & { level: number; isToggleable?: boolean }
>
export type BulletListItemBlock = WithInline<'bulletListItem', BlockColors>
export type NumberedListItemBlock = WithInline<'numberedListItem', BlockColors & { start?: number }>
export type CheckListItemBlock = WithInline<'checkListItem', BlockColors & { checked: boolean }>
export type ToggleListItemBlock = WithInline<'toggleListItem', BlockColors>
export type QuoteBlock = WithInline<'quote', BlockColors>
export type CalloutBlock = WithInline<'callout', BlockColors & { icon: string }>
export type CodeBlock = BlockBase<'codeBlock', { language: string }> & { content: StyledText[] }
export type TableBlock = BlockBase<'table', BlockColors> & { content: TableContent }
export type DividerBlock = WithoutContent<'divider', Record<string, never>>
export type ImageBlock = WithoutContent<
  'image',
  { url: string; caption: string; name?: string; previewWidth?: number }
>
export type VideoBlock = WithoutContent<'video', { url: string; caption: string; name?: string }>
export type AudioBlock = WithoutContent<'audio', { url: string; caption: string; name?: string }>
export type FileBlock = WithoutContent<'file', { url: string; name: string; caption?: string }>
export type DrawingBlock = WithoutContent<'drawing', { url: string }>
export type MathBlock = WithoutContent<'math', { latex: string }>
export type PageLinkBlock = WithoutContent<'pageLink', { href: string }>
export type RawBlock = WithoutContent<'raw', { markdown: string }>
export type ColumnListBlock = WithoutContent<'columnList', Record<string, never>>
export type ColumnBlock = WithoutContent<'column', { width: number }>
export type TocBlock = WithoutContent<'toc', Record<string, never>>

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | BulletListItemBlock
  | NumberedListItemBlock
  | CheckListItemBlock
  | ToggleListItemBlock
  | QuoteBlock
  | CalloutBlock
  | CodeBlock
  | TableBlock
  | DividerBlock
  | ImageBlock
  | VideoBlock
  | AudioBlock
  | FileBlock
  | DrawingBlock
  | MathBlock
  | PageLinkBlock
  | RawBlock
  | ColumnListBlock
  | ColumnBlock
  | TocBlock

export type BlockType = Block['type']

export const LIST_ITEM_TYPES = ['bulletListItem', 'numberedListItem', 'checkListItem'] as const

export const DEFAULT_CALLOUT_ICON = '💡'
export const DEFAULT_CALLOUT_BACKGROUND = 'gray'
