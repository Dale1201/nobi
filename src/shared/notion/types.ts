import type { Block, Inline } from '../core/blocks'

/** Kinds of things the importer could not convert exactly; each becomes a section of the report. */
export const ISSUE_KINDS = {
  skipped: 'Blocks skipped',
  unknown: 'Blocks kept as plain text',
  outsideLink: 'Links to pages outside the export',
  missingFile: 'Files missing from the export',
  download: "External images that couldn't be downloaded",
  table: 'Table formatting not kept',
  failedPage: "Pages that couldn't be converted"
} as const

export type IssueKind = keyof typeof ISSUE_KINDS

export interface Issue {
  kind: IssueKind
  detail: string
}

/** How the mapper turns references in Notion content into Nobi hrefs. */
export interface MapContext {
  /** A link's target; `pageId` is Notion's id when the content says which page it is. */
  link(href: string, pageId?: string): string
  /** An image or file reference, relative to the page being mapped or absolute. */
  file(src: string): string
  issue(kind: IssueKind, detail: string): void
}

export type NotionIcon = { emoji: string } | { src: string }

export interface MappedPage {
  title: string
  icon?: NotionIcon
  cover?: string
  /** A database row's properties, in order. */
  properties: { name: string; value: Inline[] }[]
  blocks: Block[]
}
