import type { DrawingSession } from './drawing/session'
import { create } from 'zustand'
import type { Block } from '@shared/core/blocks'
import { RECENT_LIMIT, type Settings, type TreeSnapshot } from '@shared/ipc'
import type { ImportStatus, PageNode, TrashItem, WorkspaceInfo } from '@shared/types'
import * as tabs from './lib/tabs'
import { findNode, firstPageId, pathTo } from './lib/tree'

const api = window.api

// Editors register a flush so pending autosaves land before destructive actions and quit.
// A flush resolves false when edits are still unsaved afterwards.
const flushers = new Set<() => Promise<boolean>>()
// Run before the others, for work that ends in an edit the page editors must still save.
const firstFlushers = new Set<() => Promise<boolean>>()
export function registerFlusher(
  fn: () => Promise<boolean>,
  options?: { first?: boolean }
): () => void {
  const set = options?.first ? firstFlushers : flushers
  set.add(fn)
  return () => set.delete(fn)
}
export async function flushAll(): Promise<boolean> {
  const first = await Promise.all([...firstFlushers].map((fn) => fn()))
  return [...first, ...(await Promise.all([...flushers].map((fn) => fn())))].every(Boolean)
}

// Each tab's page reports where it is scrolled, read when the tab leaves that page.
const scrollers = new Map<string, () => number>()
export function registerScroller(tabId: string, fn: () => number): () => void {
  scrollers.set(tabId, fn)
  return () => {
    if (scrollers.get(tabId) === fn) scrollers.delete(tabId)
  }
}

let errorTimer: ReturnType<typeof setTimeout> | undefined
function showError(message: string): void {
  clearTimeout(errorTimer)
  useApp.setState({ error: message })
  errorTimer = setTimeout(() => useApp.setState({ error: null }), 6000)
}

/** Edits an editor could not save when it closed, with the state it held them in. */
export interface Rescue {
  blocks: Block[]
  revision: number
  conflicted: boolean
}

export type SettingsSection = 'preferences' | 'ai' | 'connections'

export type Overlay =
  | { kind: 'search' }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'move'; pageId: string }
  | { kind: 'history'; pageId: string }
  | { kind: 'drawing'; session: DrawingSession }

export type TabTarget = tabs.TabTarget

interface AppState {
  ready: boolean
  workspace: WorkspaceInfo | null
  tree: PageNode[]
  favorites: string[]
  settings: Settings | null
  /** The open tabs; null while no workspace is open or it has no pages. */
  tabs: tabs.TabsState | null
  /** The active tab's page; null while it shows a Trash entry. */
  currentId: string | null
  renamingId: string | null
  error: string | null
  overlay: Overlay | null
  /** Open confirm dialogs; while any is open, nothing else opens over it. */
  confirms: number
  /** Rescued edits by page id, waiting for that page's editor to show them again. */
  rescued: Record<string, Rescue>
  /** The Notion import shown in the progress panel; null once dismissed. */
  importStatus: ImportStatus | null
  /** The sidebar's width while it is being dragged, before it is saved. */
  sidebarDrag: number | null
  /** Tabs whose page shows the conflict banner. */
  conflictTabs: string[]

  init: () => Promise<void>
  chooseWorkspace: () => Promise<void>
  applySnapshot: (snapshot: TreeSnapshot) => void
  /**
   * `scroll: false` when the page was picked in the sidebar, which is already showing it.
   * `tab` opens it in a new tab instead of the active one.
   */
  openPage: (id: string, options?: { scroll?: boolean; tab?: TabTarget }) => void
  back: () => void
  forward: () => void
  newTab: () => void
  closeTab: (id: string) => void
  closeTabs: (id: string, which: 'others' | 'left' | 'right') => void
  reopenClosedTab: () => void
  duplicateTab: (id: string) => void
  moveTab: (id: string, to: number) => void
  activateTab: (id: string) => void
  stepTab: (delta: 1 | -1) => void
  selectTab: (n: number) => void
  createPage: (
    parentId: string | null,
    index?: number,
    options?: { expandKey?: string; scroll?: boolean }
  ) => Promise<string>
  renamePage: (id: string, title: string) => Promise<void>
  movePage: (id: string, parentId: string | null, index: number) => Promise<void>
  trashPage: (id: string) => Promise<void>
  /** `open: false` stays on the current page, as duplicating a page block does. */
  duplicatePage: (id: string, options?: { open?: boolean }) => Promise<void>
  showTrashEntry: (item: TrashItem) => void
  restoreTrash: (entry: string) => Promise<void>
  deleteTrash: (entry: string) => Promise<void>
  /** A tab's Trash entry could not be read: it is gone, so the tab steps back. */
  trashEntryGone: (entry: string) => void
  setOverlay: (overlay: Overlay | null) => void
  workspaceMissing: () => void
  toggleFavorite: (id: string) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  setExpanded: (id: string, open: boolean) => Promise<void>
  revealInSidebar: (id: string) => Promise<void>
  /** The page whose sidebar row should scroll into view once it shows, or null. */
  revealRequest: string | null
  takeReveal: (id: string) => void
  setRenaming: (id: string | null) => void
  reportError: (action: string, err: unknown) => Promise<void>
  rescue: (id: string, rescue: Rescue) => Promise<void>
  takeRescued: (id: string) => void
  showMessage: (message: string) => void
  /** Imports these zips, or asks which ones when none are given. */
  startImport: (paths?: string[]) => Promise<void>
  cancelImport: () => Promise<void>
  setImportStatus: (status: ImportStatus | null) => void
  setSidebarDrag: (width: number | null) => void
  setTabConflict: (tabId: string, conflict: boolean) => void
}

export function errorReason(err: unknown): string {
  return err instanceof Error
    ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(err)
}

function currentOf(state: tabs.TabsState | null): string | null {
  return state ? tabs.tabPageId(tabs.activeTab(state)) : null
}

/** Records the active tab's scroll position, before it shows something else. */
function withScroll(state: tabs.TabsState): tabs.TabsState {
  const read = scrollers.get(state.activeId)
  return read ? tabs.setScroll(state, state.activeId, read()) : state
}

// While a workspace's saved tabs load, a tree update must not open a tab and save over them.
let restoring = false
let settingsWrites = 0

export const useApp = create<AppState>((set, get) => {
  const usable = (e: tabs.TabEntry): boolean =>
    e.kind === 'trash' || findNode(get().tree, e.pageId) !== null

  /** Shows the new tabs, saves them for the workspace, and counts a newly shown page as recent. */
  const setTabs = (next: tabs.TabsState | null, options?: { reveal?: boolean }): void => {
    const before = get().currentId
    const currentId = currentOf(next)
    set({ tabs: next, currentId })
    const { workspace, settings } = get()
    if (!workspace || !settings) return
    const patch: Partial<Settings> = {}
    if (next) patch.tabs = { ...settings.tabs, [workspace.root]: tabs.serialize(next) }
    if (currentId && currentId !== before) {
      const recent = [currentId, ...(settings.recent[workspace.root] ?? [])]
      patch.recent = {
        ...settings.recent,
        [workspace.root]: [...new Set(recent)].slice(0, RECENT_LIMIT)
      }
      if (options?.reveal) void get().revealInSidebar(currentId)
    }
    if (Object.keys(patch).length) void get().updateSettings(patch)
  }

  /** Moves a tab within its history; back and forward skip pages that are gone. */
  const go = (delta: 1 | -1): void => {
    const state = get().tabs
    if (!state) return
    const index = tabs.nearest(tabs.activeTab(state), delta, usable)
    if (index === null) return
    const next = tabs.goTo(withScroll(state), state.activeId, index)
    const id = currentOf(next)
    set({ revealRequest: id })
    setTabs(next, { reveal: true })
  }

  /** The tab steps back to the nearest earlier usable entry, or closes; the last tab opens the first page. */
  const stepBack = (state: tabs.TabsState, tabId: string): tabs.TabsState | null => {
    const tab = state.tabs.find((t) => t.id === tabId)!
    const index = tabs.nearest(tab, -1, usable)
    if (index !== null) return tabs.goTo(state, tabId, index)
    if (state.tabs.length > 1) {
      const closed = tabs.closeTabs(state, [tabId])
      return { ...closed, closed: state.closed }
    }
    const first = firstPageId(get().tree)
    return first ? tabs.initialTabs(first) : null
  }

  /** Tabs showing pages that left the tree show their Trash entry, or step back if they are gone. */
  const settleMissing = async (previous: PageNode[]): Promise<void> => {
    const missing = (state: tabs.TabsState): tabs.Tab[] =>
      state.tabs.filter((t) => {
        const id = tabs.tabPageId(t)
        return id !== null && !findNode(get().tree, id)
      })
    if (!get().tabs || missing(get().tabs!).length === 0) return
    const trash = await api.invoke('trash:list', undefined).catch(() => [] as TrashItem[])
    let state = get().tabs
    if (!state) return
    for (const tab of missing(state)) {
      const pageId = tabs.tabPageId(tab)!
      const item = trash.find((i) => i.pageIds.includes(pageId))
      if (item) {
        const node = findNode(previous, pageId)
        state = tabs.replaceCurrent(state, tab.id, {
          kind: 'trash',
          entry: item.entry,
          title: node?.title ?? item.title,
          icon: node ? node.icon : item.icon,
          pageId,
          scroll: 0
        })
      } else {
        const next = stepBack(state, tab.id)
        if (!next) {
          set({ tabs: null, currentId: null })
          return
        }
        state = next
      }
    }
    setTabs(state)
  }

  /** The workspace's saved tabs, or one tab on its last page or first page. */
  const restoreTabs = async (root: string): Promise<void> => {
    restoring = true
    try {
      await loadTabs(root)
    } finally {
      restoring = false
    }
  }

  const loadTabs = async (root: string): Promise<void> => {
    const { tree, settings } = get()
    const saved = settings?.tabs[root]
    let state: tabs.TabsState | null = null
    if (saved) {
      const ids = saved.tabs.flatMap((t) => t.history)
      const inTrash = ids.some((id) => !findNode(tree, id))
        ? (await api.invoke('trash:list', undefined).catch(() => [] as TrashItem[])).flatMap(
            (i) => i.pageIds
          )
        : []
      state = tabs.restore(saved, (id) => findNode(tree, id) !== null || inTrash.includes(id))
    }
    if (!state) {
      const last = settings?.lastPage[root]
      const start = last && findNode(tree, last) ? last : firstPageId(tree)
      if (start) state = tabs.initialTabs(start)
    }
    set({ revealRequest: currentOf(state) })
    setTabs(state, { reveal: true })
    await settleMissing(tree)
  }

  return {
    ready: false,
    workspace: null,
    tree: [],
    favorites: [],
    settings: null,
    tabs: null,
    currentId: null,
    revealRequest: null,
    renamingId: null,
    error: null,
    overlay: null,
    confirms: 0,
    rescued: {},
    importStatus: null,
    sidebarDrag: null,
    conflictTabs: [],

    init: async () => {
      const [settings, workspace] = await Promise.all([
        api.invoke('settings:get', undefined),
        api.invoke('workspace:current', undefined)
      ])
      set({ settings, workspace })
      if (workspace) {
        restoring = true
        get().applySnapshot(await api.invoke('tree:get', undefined))
        await restoreTabs(workspace.root)
      }
      set({ ready: true })
    },

    chooseWorkspace: async () => {
      // Pending edits must land in the workspace they belong to.
      if (!(await flushAll())) return
      let workspace: WorkspaceInfo | null
      try {
        workspace = await api.invoke('workspace:choose', undefined)
      } catch (e) {
        showError(`Couldn't open that folder: ${errorReason(e)}`)
        return
      }
      if (!workspace) return
      restoring = true
      set({
        workspace,
        tabs: null,
        currentId: null,
        overlay: null,
        importStatus: null
      })
      get().applySnapshot(await api.invoke('tree:get', undefined))
      if (get().tree.length === 0) {
        restoring = false
        await get().createPage(null)
      } else await restoreTabs(workspace.root)
    },

    applySnapshot: ({ pages, favorites }) => {
      const previous = get().tree
      set({ tree: pages, favorites })
      // Pages can arrive after the workspace opened with none, or after the last one was deleted.
      if (!get().tabs && !restoring && get().workspace && pages.length) {
        setTabs(tabs.initialTabs(pages[0].id))
        return
      }
      void settleMissing(previous)
    },

    openPage: (id, options) => {
      const state = get().tabs
      const target = options?.tab ?? 'current'
      if (!state) {
        set({ revealRequest: options?.scroll === false ? null : id })
        setTabs(tabs.initialTabs(id), { reveal: true })
        return
      }
      if (target !== 'current') {
        const entries = [tabs.pageEntry(id)]
        const next = tabs.openInTab(withScroll(state), entries, 0, target)
        if (target === 'foreground') set({ revealRequest: id })
        setTabs(next, { reveal: target === 'foreground' })
        return
      }
      // The page is already open, but a search or link to it still shows it in the sidebar.
      if (id === get().currentId) {
        if (options?.scroll !== false) set({ revealRequest: id })
        void get().revealInSidebar(id)
        return
      }
      set({ revealRequest: options?.scroll === false ? null : id })
      setTabs(tabs.navigate(withScroll(state), state.activeId, tabs.pageEntry(id)), {
        reveal: true
      })
    },

    back: () => go(-1),
    forward: () => go(1),

    newTab: () => {
      const state = get().tabs
      if (!state) return
      const entry = tabs.currentEntry(tabs.activeTab(state))
      setTabs(tabs.openInTab(withScroll(state), [{ ...entry, scroll: 0 }], 0, 'next'))
    },

    closeTab: (id) => {
      const state = get().tabs
      if (!state) return
      // The last tab stays saved, so the window opens on it again.
      if (state.tabs.length === 1) {
        void api.invoke('window:close', undefined)
        return
      }
      setTabs(tabs.closeTabs(state, [id]))
    },

    closeTabs: (id, which) => {
      const state = get().tabs
      if (!state) return
      setTabs(which === 'others' ? tabs.closeOthers(state, id) : tabs.closeSide(state, id, which))
    },

    reopenClosedTab: () => {
      const state = get().tabs
      if (!state?.closed.length) return
      setTabs(tabs.reopen(withScroll(state)))
      void settleMissing(get().tree)
    },

    duplicateTab: (id) => {
      const state = get().tabs
      if (state) setTabs(tabs.duplicate(withScroll(state), id))
    },

    moveTab: (id, to) => {
      const state = get().tabs
      if (state) setTabs(tabs.moveTab(state, id, to))
    },

    activateTab: (id) => {
      const state = get().tabs
      if (state && state.activeId !== id) setTabs(tabs.activate(withScroll(state), id))
    },

    stepTab: (delta) => {
      const state = get().tabs
      if (state && state.tabs.length > 1) setTabs(tabs.step(withScroll(state), delta))
    },

    selectTab: (n) => {
      const state = get().tabs
      if (state) setTabs(tabs.selectNumber(withScroll(state), n))
    },

    createPage: async (parentId, index, options) => {
      // The parent gets a link to the new page; open editors save first, so they can reload it.
      if (parentId) await flushAll()
      const node = await api.invoke('page:create', { parentId, index, link: true })
      if (parentId) await get().setExpanded(options?.expandKey ?? parentId, true)
      get().openPage(node.id, { scroll: options?.scroll })
      return node.id
    },

    renamePage: async (id, title) => {
      await api.invoke('page:rename', { id, title }).catch((e) => get().reportError('rename', e))
    },

    movePage: async (id, parentId, index) => {
      await flushAll()
      try {
        await api.invoke('page:move', { id, parentId, index })
        if (parentId) await get().setExpanded(parentId, true)
      } catch (e) {
        await get().reportError('move', e)
      }
    },

    trashPage: async (id) => {
      if (!(await flushAll())) return
      await api.invoke('page:trash', { id }).catch((e) => get().reportError('delete', e))
    },

    duplicatePage: async (id, options) => {
      if (!(await flushAll())) return
      try {
        const node = await api.invoke('page:duplicate', { id })
        if (options?.open !== false) get().openPage(node.id)
      } catch (e) {
        await get().reportError('duplicate', e)
      }
    },

    showTrashEntry: (item) => {
      const state = get().tabs
      const shown = state && tabs.currentEntry(tabs.activeTab(state))
      if (shown?.kind === 'trash' && shown.entry === item.entry) return
      const entry: tabs.TabEntry = {
        kind: 'trash',
        entry: item.entry,
        title: item.title,
        icon: item.icon,
        scroll: 0
      }
      setTabs(state ? tabs.navigate(withScroll(state), state.activeId, entry) : null)
    },

    restoreTrash: async (entry) => {
      // A restore can link the page from its parent again; open editors save first.
      if (!(await flushAll())) return
      try {
        const id = await api.invoke('trash:restore', { entry })
        let state = get().tabs
        if (!state) return get().openPage(id)
        let shown = false
        for (const tab of state.tabs) {
          const e = tabs.currentEntry(tab)
          if (e.kind !== 'trash' || e.entry !== entry) continue
          shown = true
          state = tabs.replaceCurrent(state, tab.id, tabs.pageEntry(e.pageId ?? id))
        }
        if (shown) setTabs(state)
        else get().openPage(id)
      } catch (e) {
        await get().reportError('restore', e)
      }
    },

    deleteTrash: async (entry) => {
      try {
        await api.invoke('trash:delete', { entry })
        get().trashEntryGone(entry)
      } catch (e) {
        await get().reportError('delete', e)
      }
    },

    trashEntryGone: (entry) => {
      let state = get().tabs
      if (!state) return
      const showing = (t: tabs.Tab): boolean => {
        const e = tabs.currentEntry(t)
        return e.kind === 'trash' && e.entry === entry
      }
      if (!state.tabs.some(showing)) return
      for (const tab of state.tabs.filter(showing)) {
        state = stepBack(state!, tab.id)
        if (!state) break
      }
      setTabs(state)
    },

    setOverlay: (overlay) => set({ overlay }),

    workspaceMissing: () =>
      set({
        workspace: null,
        tabs: null,
        currentId: null,
        overlay: null,
        tree: [],
        favorites: [],
        importStatus: null
      }),

    toggleFavorite: async (id) => {
      await api
        .invoke('page:favorite', { id, favorite: !get().favorites.includes(id) })
        .catch((e) => get().reportError('update favorites for', e))
    },

    updateSettings: async (patch) => {
      // Applied at once so a patch sent before the last one returns builds on it, not on stale settings.
      const settings = get().settings
      if (settings) set({ settings: { ...settings, ...patch } })
      const write = ++settingsWrites
      const saved = await api.invoke('settings:set', patch)
      if (write === settingsWrites) set({ settings: saved })
    },

    setExpanded: async (id, open) => {
      const { settings, workspace } = get()
      if (!settings || !workspace) return
      const current = new Set(settings.expanded[workspace.root] ?? [])
      if (open === current.has(id)) return
      if (open) current.add(id)
      else current.delete(id)
      await get().updateSettings({
        expanded: { ...settings.expanded, [workspace.root]: [...current] }
      })
    },

    takeReveal: (id) => {
      if (get().revealRequest === id) set({ revealRequest: null })
    },

    revealInSidebar: async (id) => {
      const { settings, workspace, tree } = get()
      if (!settings || !workspace) return
      const current = settings.expanded[workspace.root] ?? []
      const missing = pathTo(tree, id)
        .slice(0, -1)
        .map((n) => n.id)
        .filter((a) => !current.includes(a))
      if (missing.length === 0) return
      await get().updateSettings({
        expanded: { ...settings.expanded, [workspace.root]: [...current, ...missing] }
      })
    },

    setRenaming: (id) => set({ renamingId: id }),

    showMessage: (message) => showError(message),

    startImport: async (paths) => {
      try {
        if (paths) await api.invoke('import:start', { paths })
        else await api.invoke('import:choose', undefined)
      } catch (e) {
        showError(errorReason(e))
      }
    },

    cancelImport: async () => {
      await api.invoke('import:cancel', undefined).catch(() => {})
    },

    setImportStatus: (importStatus) => set({ importStatus }),

    setSidebarDrag: (sidebarDrag) => set({ sidebarDrag }),

    setTabConflict: (tabId, conflict) => {
      const tabs = get().conflictTabs.filter((t) => t !== tabId)
      set({ conflictTabs: conflict ? [...tabs, tabId] : tabs })
    },

    /** Shows what failed and re-syncs the sidebar with what is actually on disk. */
    reportError: async (action, err) => {
      showError(`Couldn't ${action} the page: ${errorReason(err)}`)
      const snapshot = await api.invoke('tree:get', undefined).catch(() => null)
      if (snapshot) get().applySnapshot(snapshot)
    },

    /** Opens the page again in a new tab with the edits, or a new page with them if it was deleted. */
    rescue: async (id, rescue) => {
      if (findNode(get().tree, id)) {
        set({ rescued: { ...get().rescued, [id]: rescue } })
        return get().openPage(id, { tab: 'foreground' })
      }
      // With the notes folder gone, creating a page would bring back an empty copy of it.
      if (!get().workspace) return
      try {
        const node = await api.invoke('page:create', {
          parentId: null,
          title: 'Recovered edits',
          blocks: rescue.blocks
        })
        get().openPage(node.id, { tab: 'foreground' })
      } catch (e) {
        await get().reportError('recover', e)
      }
    },

    takeRescued: (id) => {
      const rescued = { ...get().rescued }
      delete rescued[id]
      set({ rescued })
    }
  }
})
