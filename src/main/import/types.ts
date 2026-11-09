import type { Block } from '../../shared/core/blocks'
import type { IssueKind } from '../../shared/notion/types'
import type { ImportProgress } from '../../shared/types'

/** Hrefs to imported files use this scheme until landing gives each file its final name. */
export const STAGED_FILE_PREFIX = 'nobi-import:file/'

export interface StagedPage {
  /** The page's new Nobi id. */
  id: string
  notionId?: string
  parentId: string | null
  title: string
  /** An emoji, or a staged file href. */
  icon?: string
  cover?: string
  /** Links use internal hrefs: `nobi://page/<id>` and staged file hrefs. */
  blocks: Block[]
}

export interface StagedFile {
  key: string
  /** The name the file had in Notion. */
  name: string
  /** Absolute path of the copy in the staging folder; missing when a download failed. */
  path?: string
  /** The address a failed download is linked to instead. */
  url?: string
}

export interface StagedIssue {
  kind: IssueKind
  detail: string
  pageId: string
}

export interface ImportManifest {
  pages: StagedPage[]
  files: StagedFile[]
  issues: StagedIssue[]
  sources: string[]
  startedAt: number
}

export type WorkerMessage =
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'done'; manifest: ImportManifest }
  | { type: 'error'; message: string }

/** Sent to the worker, which aborts its run and exits on its own. */
export type WorkerCommand = { type: 'stop' }

export interface WorkerInput {
  zips: string[]
  staging: string
}

/** A failure whose message is meant for the user, as opposed to a bug. */
export class ImportError extends Error {}
