import type Anthropic from '@anthropic-ai/sdk'
import {
  CURSOR,
  modeOf,
  SELECTION_END,
  SELECTION_START,
  skill as skillById,
  type AiMode,
  type AiStart
} from '../../shared/ai'

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
type Tool = Anthropic.Beta.Messages.BetaTool

export const PAGE_LIMIT = 100_000

// Byte-identical on every request, so it heads the cached prefix.
export const SYSTEM_PROMPT = [
  'You are the writing assistant inside Nobi, a note-taking app.',
  "The user's current page is given in Markdown inside <page> tags.",
  '⟦selection⟧ and ⟦/selection⟧ mark the text the user selected, and ⟦cursor⟧ marks where the cursor is.',
  'These markers are not part of the page: never write them.',
  '',
  'Follow the instruction and give the result only: no preamble, no explanation, no closing remarks, and no code fence around the whole result.',
  'Write Markdown in the style of the page, and keep links, page links and formatting.',
  'Keep the language of the text unless asked to translate.',
  'Never invent facts, names, numbers or dates that the page does not support.',
  'A result for the selection replaces only the selected text, so do not repeat the text around it.',
  'A result for the cursor is inserted there, so do not repeat the page.'
].join('\n')

const MARKDOWN_INPUT = {
  type: 'object' as const,
  properties: { markdown: { type: 'string', description: 'The result, in Markdown.' } },
  required: ['markdown'],
  additionalProperties: false
}

const tool = (name: AiMode, description: string): Tool => ({
  name,
  description,
  input_schema: MARKDOWN_INPUT,
  strict: true,
  eager_input_streaming: true
})

export const TOOLS: Record<AiMode, Tool> = {
  edit: tool(
    'edit',
    'Replace the selected text with this Markdown. Use it when the user asks to change, rewrite, translate or format the selection.'
  ),
  insert: tool(
    'insert',
    'Insert this Markdown at the cursor. Use it when the user asks you to write something.'
  ),
  reply: tool(
    'reply',
    'Answer the user in the AI popup without changing the page. Use it for questions about the page or the selection.'
  )
}

/** Keeps PAGE_LIMIT characters centred on the selection or cursor, marking each cut. */
export function trimPage(markdown: string): string {
  if (markdown.length <= PAGE_LIMIT) return markdown
  const from = markdown.indexOf(SELECTION_START)
  const close = markdown.indexOf(SELECTION_END)
  const to = from >= 0 && close > from ? close + SELECTION_END.length : -1
  // A selection longer than the window keeps its start, and is closed where it is cut.
  if (to >= 0 && to - from > PAGE_LIMIT) {
    const cut = from + PAGE_LIMIT < close
    return (
      (from > 0 ? '[…]\n' : '') +
      markdown.slice(from, cut ? from + PAGE_LIMIT : close) +
      (cut ? '\n[…]\n' : '') +
      SELECTION_END +
      (to < markdown.length ? '\n[…]' : '')
    )
  }
  const center =
    to >= 0
      ? Math.floor((from + to) / 2)
      : ([SELECTION_START, CURSOR].map((m) => markdown.indexOf(m)).find((i) => i >= 0) ?? 0)
  const start = Math.max(0, Math.min(center - PAGE_LIMIT / 2, markdown.length - PAGE_LIMIT))
  const end = start + PAGE_LIMIT
  return (
    (start > 0 ? '[…]\n' : '') + markdown.slice(start, end) + (end < markdown.length ? '\n[…]' : '')
  )
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** The instruction for a new request: a skill's own, a finished prefill, or free text. */
export function instructionText(start: AiStart): string {
  const typed = start.instruction?.trim() ?? ''
  if (!start.skill) return typed
  const s = skillById(start.skill)
  if (!s.prefill) return s.instruction
  if (s.kind === 'editPage')
    return `${typed}. The result replaces the whole page, so write all of it.`
  return `${typed}. Apply it to the selection.`
}

/** Free text lets Claude choose between changing the page and replying. */
export function toolsFor(start: AiStart): Tool[] | null {
  if (start.skill) return null
  return [start.selection ? TOOLS.edit : TOOLS.insert, TOOLS.reply]
}

export function modeFor(start: AiStart): AiMode | null {
  return start.skill ? modeOf(skillById(start.skill).kind) : null
}

export function firstMessage(start: AiStart): MessageParam {
  const page = `<page title="${escapeAttr(start.title)}">\n${trimPage(start.markdown)}\n</page>`
  const tools = toolsFor(start)
  const text = tools
    ? `${instructionText(start)}\n\nCall exactly one of the tools ${tools.map((t) => t.name).join(' or ')}.`
    : instructionText(start)
  return {
    role: 'user',
    content: [
      { type: 'text', text: page, cache_control: { type: 'ephemeral' } },
      { type: 'text', text }
    ]
  }
}

/** A follow-up after `previous`, Claude's last turn, which is sent back unchanged. */
export function followUpMessage(
  previous: Anthropic.Beta.Messages.BetaContentBlock[],
  text: string
): MessageParam {
  const results = previous.flatMap((block) =>
    block.type === 'tool_use'
      ? [{ type: 'tool_result' as const, tool_use_id: block.id, content: 'Shown to the user.' }]
      : []
  )
  return {
    role: 'user',
    content: [
      ...results,
      {
        type: 'text',
        text: `Revise your last result: ${text.trim()}\nGive the whole revised result.`
      }
    ]
  }
}
