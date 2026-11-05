import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultProps,
  type Block,
  type PartialBlock
} from '@blocknote/core'
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
  useEditorChange
} from '@blocknote/react'
import { codeBlockOptions } from '@blocknote/code-block'
import { withMultiColumn } from '@blocknote/xl-multi-column'
import { createContext, useContext, useState } from 'react'
import { PageIconView } from '../components/PageIconView'
import { IconPickerPopover } from '../components/PageHeader'
import { openDrawing } from '../drawing/session'
import { resolveAssetUrl } from '../lib/assets'
import { decodeHref } from '@shared/core/paths'
import { Katex } from './Katex'
import { dividerShortcut, headingShortcuts, quoteShortcut } from './markdownShortcuts'
import type { LinkClick } from '../lib/navigation'

export type PageLinkContextValue = {
  resolve(href: string): { title: string; icon?: string } | null
  open(href: string, click?: LinkClick): void
}

// The middle button opens a page link in a new tab; without this it would start autoscrolling.
const onMiddleDown = (e: React.MouseEvent): void => {
  if (e.button === 1) e.preventDefault()
}

export const PageLinkContext = createContext<PageLinkContextValue | null>(null)

/** A link to a page that is gone shows the name its file had. */
function missingTitle(href: string): string {
  return decodeHref(href.split('/').pop() ?? href).replace(/\.md$/i, '') || href
}

export const createCallout = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: {
      textColor: defaultProps.textColor,
      backgroundColor: { default: 'gray' },
      icon: { default: '💡' }
    },
    content: 'inline'
  },
  {
    render: function Callout({ block, editor, contentRef }) {
      const [picker, setPicker] = useState<DOMRect | null>(null)
      const { icon } = block.props
      return (
        // BlockNote paints backgroundColor/textColor on the enclosing .bn-block.
        <div className="nb-callout">
          {icon && (
            <button
              className="nb-callout-icon"
              contentEditable={false}
              aria-label="Change icon"
              disabled={!editor.isEditable}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}
            >
              {icon.startsWith('/') ? <img src={resolveAssetUrl(icon)} alt="" /> : icon}
            </button>
          )}
          <div className="nb-callout-content" ref={contentRef} />
          {picker && (
            <IconPickerPopover
              anchor={picker}
              onChange={(next) => editor.updateBlock(block, { props: { icon: next ?? '' } })}
              onClose={() => setPicker(null)}
            />
          )}
        </div>
      )
    }
  }
)

export const createMath = createReactBlockSpec(
  {
    type: 'math',
    propSchema: { latex: { default: '' } },
    content: 'none'
  },
  {
    render: function MathBlock({ block, editor }) {
      const [editing, setEditing] = useState(false)
      if (editing) {
        return (
          <textarea
            className="nb-math-source"
            autoFocus
            defaultValue={block.props.latex}
            onBlur={(e) => {
              editor.updateBlock(block, {
                props: { latex: e.currentTarget.value }
              })
              setEditing(false)
            }}
          />
        )
      }
      return (
        <div className="nb-math" onClick={() => editor.isEditable && setEditing(true)}>
          {block.props.latex ? (
            <Katex latex={block.props.latex} displayMode />
          ) : (
            <span className="nb-math-empty">Add a TeX equation</span>
          )}
        </div>
      )
    }
  }
)

export const createPageLink = createReactBlockSpec(
  {
    type: 'pageLink',
    propSchema: { href: { default: '' } },
    content: 'none'
  },
  {
    render: function PageLinkBlock({ block }) {
      const ctx = useContext(PageLinkContext)
      const target = ctx?.resolve(block.props.href)
      // A page deleted while this link shows keeps the title it had.
      const [seen, setSeen] = useState(target?.title)
      if (target && target.title !== seen) setSeen(target.title)
      return (
        <div
          className="nb-page-link"
          data-missing={target ? undefined : 'true'}
          onClick={(e) => ctx?.open(block.props.href, e)}
          onMouseDown={onMiddleDown}
          onAuxClick={(e) => e.button === 1 && ctx?.open(block.props.href, e)}
        >
          <span className="nb-page-link-icon">
            <PageIconView icon={target?.icon} size={18} />
          </span>
          <span className="nb-page-link-title">
            {target?.title ?? seen ?? missingTitle(block.props.href)}
          </span>
        </div>
      )
    }
  }
)

export const createDrawing = createReactBlockSpec(
  {
    type: 'drawing',
    propSchema: { url: { default: '' } },
    content: 'none'
  },
  {
    render: function DrawingBlock({ block, editor }) {
      const { url } = block.props
      const [missing, setMissing] = useState<string | null>(null)
      // A new drawing has no file until its editor saves one.
      if (!url) return <div className="nb-drawing-new" />
      if (missing === url) {
        return (
          <div className="nb-drawing-missing">
            Drawing not found: {decodeHref(url.split('/').pop() ?? url)}
          </div>
        )
      }
      return (
        <div
          className="nb-drawing"
          data-editable={editor.isEditable ? 'true' : undefined}
          onClick={() => editor.isEditable && openDrawing(editor as unknown as AppEditor, block.id)}
        >
          <img
            src={resolveAssetUrl(url)}
            alt=""
            draggable={false}
            onError={() => setMissing(url)}
          />
        </div>
      )
    }
  }
)

interface TocEntry {
  id: string
  level: number
  text: string
}

// Structural, so the block spec does not depend on the schema type it is part of.
interface OutlineBlock {
  id: string
  type: string
  props: { level?: number }
  content?: unknown
  children: OutlineBlock[]
}

type OutlineInline = { type: string; text?: string; content?: { text: string }[] }

function tocEntries(blocks: OutlineBlock[], out: TocEntry[] = []): TocEntry[] {
  for (const block of blocks) {
    if (block.type === 'heading' && Array.isArray(block.content)) {
      const text = (block.content as OutlineInline[])
        .map((c) => c.text ?? c.content?.map((t) => t.text).join('') ?? '')
        .join('')
      out.push({ id: block.id, level: block.props.level ?? 1, text })
    }
    tocEntries(block.children, out)
  }
  return out
}

function sameEntries(a: TocEntry[], b: TocEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => e.id === b[i].id && e.text === b[i].text && e.level === b[i].level)
  )
}

/** A heading in a collapsed toggle has no box, so scroll to the nearest ancestor that does. */
function scrollToBlock(root: HTMLElement | undefined, id: string): void {
  let el = root?.querySelector<HTMLElement>(`[data-id="${id}"]`) ?? null
  while (el && el.getClientRects().length === 0) {
    el = el.parentElement?.closest<HTMLElement>('.bn-block-outer') ?? null
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  el?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
}

export const createToc = createReactBlockSpec(
  {
    type: 'toc',
    propSchema: {},
    content: 'none'
  },
  {
    render: function TocBlock({ editor }) {
      const [entries, setEntries] = useState(() => tocEntries(editor.document as OutlineBlock[]))
      useEditorChange(() => {
        const next = tocEntries(editor.document as OutlineBlock[])
        setEntries((prev) => (sameEntries(prev, next) ? prev : next))
      }, editor)
      if (entries.length === 0) {
        return <div className="nb-toc-empty">Add headings to create a table of contents.</div>
      }
      const top = Math.min(...entries.map((e) => e.level))
      return (
        <nav className="nb-toc">
          {entries.map((entry) => (
            <button
              key={entry.id}
              className="nb-toc-item"
              style={{ paddingLeft: 6 + (entry.level - top) * 24 }}
              onClick={() => scrollToBlock(editor.domElement, entry.id)}
            >
              <span className="nb-toc-text">{entry.text || 'Untitled'}</span>
            </button>
          ))}
        </nav>
      )
    }
  }
)

export const createRaw = createReactBlockSpec(
  {
    type: 'raw',
    propSchema: { markdown: { default: '' } },
    content: 'none'
  },
  {
    render: ({ block }) => <pre className="nb-raw">{block.props.markdown}</pre>
  }
)

export const InlineMath = createReactInlineContentSpec(
  {
    type: 'inlineMath',
    propSchema: { latex: { default: '' } },
    content: 'none'
  },
  {
    render: ({ inlineContent }) => (
      <span className="nb-inline-math">
        <Katex latex={inlineContent.props.latex} displayMode={false} />
      </span>
    )
  }
)

export const PageMention = createReactInlineContentSpec(
  {
    type: 'pageMention',
    propSchema: { href: { default: '' }, title: { default: '' } },
    content: 'none'
  },
  {
    render: function PageMentionChip({ inlineContent }) {
      const ctx = useContext(PageLinkContext)
      const { href, title } = inlineContent.props
      const target = ctx?.resolve(href)
      return (
        <span
          className="nb-mention"
          data-missing={target ? undefined : 'true'}
          onClick={(e) => target && ctx?.open(href, e)}
          onMouseDown={onMiddleDown}
          onAuxClick={(e) => e.button === 1 && target && ctx?.open(href, e)}
        >
          <span className="nb-mention-icon">
            <PageIconView icon={target?.icon} size={14} />
          </span>
          <span className="nb-mention-title">{target?.title ?? (title || 'Untitled')}</span>
        </span>
      )
    }
  }
)

export const schema = withMultiColumn(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      quote: { ...defaultBlockSpecs.quote, extensions: [quoteShortcut] },
      heading: { ...defaultBlockSpecs.heading, extensions: [headingShortcuts] },
      divider: { ...defaultBlockSpecs.divider, extensions: [dividerShortcut()] },
      codeBlock: createCodeBlockSpec(codeBlockOptions),
      callout: createCallout(),
      math: createMath(),
      pageLink: createPageLink(),
      drawing: createDrawing(),
      raw: createRaw(),
      toc: createToc()
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      inlineMath: InlineMath,
      pageMention: PageMention
    }
  })
)

export type AppSchema = typeof schema
export type AppEditor = AppSchema['BlockNoteEditor']
export type AppBlock = Block<
  AppSchema['blockSchema'],
  AppSchema['inlineContentSchema'],
  AppSchema['styleSchema']
>
export type AppPartialBlock = PartialBlock<
  AppSchema['blockSchema'],
  AppSchema['inlineContentSchema'],
  AppSchema['styleSchema']
>
