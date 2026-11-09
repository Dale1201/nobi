import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

export type ContextMenuInfo = Pick<
  ContextMenuParams,
  'misspelledWord' | 'dictionarySuggestions' | 'isEditable' | 'editFlags' | 'selectionText'
>

export interface SpellingActions {
  replace: (suggestion: string) => void
  addToDictionary: (word: string) => void
}

/** The right-click menu: fixes for a misspelled word first, then the edit actions that apply. */
export function contextMenuTemplate(
  info: ContextMenuInfo,
  spelling: SpellingActions
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const word = info.misspelledWord
  if (word) {
    const suggestions = info.dictionarySuggestions
    if (suggestions.length === 0) items.push({ label: 'No Guesses Found', enabled: false })
    for (const suggestion of suggestions)
      items.push({ label: suggestion, click: () => spelling.replace(suggestion) })
    items.push(
      { type: 'separator' },
      { label: 'Add to Dictionary', click: () => spelling.addToDictionary(word) },
      { type: 'separator' }
    )
  }
  if (info.isEditable) {
    items.push(
      { role: 'cut', enabled: info.editFlags.canCut },
      { role: 'copy', enabled: info.editFlags.canCopy },
      { role: 'paste', enabled: info.editFlags.canPaste }
    )
  } else if (info.selectionText.trim()) {
    items.push({ role: 'copy' })
  }
  return items
}
