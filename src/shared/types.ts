import type { Block } from './core/blocks'
import type { PageMeta } from './core/page'

export interface WorkspaceInfo {
  root: string
  name: string
}

export interface PageNode {
  id: string
  title: string
  icon?: string
  /** Workspace-relative posix path of the page file, e.g. "Projects/Plan.md". */
  path: string
  children: PageNode[]
}

/** A page as the renderer sees it: links use internal hrefs (see core/links). */
export interface PageDoc {
  id: string
  title: string
  path: string
  meta: PageMeta
  blocks: Block[]
  /** Bumped when the file changes other than through the editor's own saves. */
  revision: number
  /** The frontmatter is not valid YAML, so it is shown as text. */
  frontmatterError?: boolean
}

export type WriteResult =
  | { ok: true; revision: number }
  /** `conflict`: the file changed since the editor loaded it. `gone`: the page was deleted. */
  | { ok: false; reason: 'conflict' | 'gone' }

/** A watcher event, with a workspace-relative posix path. */
export interface FileChange {
  kind: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
  path: string
}

export interface TrashItem {
  /** Folder name under `.nobi/trash/`. */
  entry: string
  pageId: string
  title: string
  icon?: string
  /** Title of the original parent if it still exists; null for top-level pages or a missing parent. */
  parentTitle: string | null
  deletedAt: string
  /** The page plus its sub-pages. */
  pageCount: number
  /** Ids of the page and its sub-pages. */
  pageIds: string[]
}

export interface PageMetaPatch {
  icon?: string | null
  cover?: string | null
  coverPosition?: number | null
  fullWidth?: boolean
}

/** Start (inclusive) and end (exclusive) offsets of a highlighted span. */
export type TextRange = [number, number]

export interface SearchHit {
  id: string
  titleRanges: TextRange[]
  /** One line of matching content, or null when only the title matched. */
  snippet: { text: string; ranges: TextRange[] } | null
}

export interface HistoryVersion {
  /** Filename-safe timestamp, e.g. 2026-10-21T14-03-22-123Z. */
  id: string
  /** ISO time the snapshot was taken. */
  at: string
}

export interface ImportProgress {
  phase: 'reading' | 'converting' | 'copying' | 'finishing'
  done: number
  total: number
}

export type ImportStatus =
  | { state: 'running'; progress: ImportProgress }
  | { state: 'done'; rootId: string; reportId: string; pages: number; issues: number }
  | { state: 'cancelled' }
  | { state: 'failed'; message: string }

export interface ImportResult {
  rootId: string
  reportId: string
  pages: number
  issues: number
}
