import { useEffect, useRef, useState } from 'react'
import { AI_MODELS, isAiModel, type AiModel } from '@shared/ai'
import type { ThemePreference } from '@shared/ipc'
import { mcpAddCommand, type McpStatus } from '@shared/mcp'
import { useAi } from '../ai/aiStore'
import { KeyField } from '../ai/KeyField'
import { CONSOLE_URL, KEYS_URL, openExternal, PRIVACY_URL } from '../ai/links'
import { useApp, type SettingsSection } from '../store'
import { ChevronDownIcon, CloseIcon, PlugIcon, SlidersIcon, SparkleIcon } from './icons'
import { Menu } from './menu/Menu'
import { Modal } from './Modal'

const api = window.api

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'Use system setting' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

const MODEL_NOTE =
  'Opus: best writing, about 2¢ per action. Sonnet: faster, about 1¢. Haiku: fastest, under 0.1¢.'

function ExternalLink({ url, children }: { url: string; children: string }): React.JSX.Element {
  return (
    <a
      href={url}
      className="settings-link"
      onClick={(e) => {
        e.preventDefault()
        openExternal(url)
      }}
    >
      {children}
    </a>
  )
}

function Row({
  label,
  description,
  children
}: {
  label: string
  description?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {description && <div className="settings-row-description">{description}</div>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  )
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={button}
        type="button"
        className="settings-select"
        aria-label={label}
        aria-haspopup="menu"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {options.find((o) => o.id === value)?.label}
        <ChevronDownIcon size={12} />
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          align="end"
          className="settings-menu"
          onClose={() => {
            setAnchor(null)
            button.current?.focus()
          }}
          entries={options.map((o) => ({
            kind: 'item',
            id: o.id,
            label: o.label,
            checked: o.id === value,
            onSelect: () => onChange(o.id)
          }))}
        />
      )}
    </>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`settings-toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

function Page({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </header>
      {children}
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="settings-section">
      <h2 className="settings-title">{title}</h2>
      <div className="settings-rows">{children}</div>
    </section>
  )
}

function PreferencesPage(): React.JSX.Element {
  const theme = useApp((s) => s.settings?.theme ?? 'system')
  return (
    <Page title="Preferences">
      <Section title="Appearance">
        <Row label="Theme" description="Choose a theme for Nobsidian on this device">
          <Select
            label="Theme"
            value={theme}
            options={THEMES}
            onChange={(value) => void useApp.getState().updateSettings({ theme: value })}
          />
        </Row>
      </Section>
    </Page>
  )
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`
}

function AiPage(): React.JSX.Element {
  const ai = useApp((s) => s.settings?.ai)
  const status = useAi((s) => s.status)
  const enabled = ai?.enabled ?? true
  const model: AiModel = isAiModel(ai?.model) ? ai.model : AI_MODELS[0].id
  const update = (patch: Partial<{ enabled: boolean; model: AiModel }>): void =>
    void useApp.getState().updateSettings({ ai: { enabled, model, ...patch } })
  const requests = status?.month.requests ?? 0
  return (
    <Page
      title="AI"
      description="Write and edit your pages with Claude, using your own Anthropic API key."
    >
      <Section title="General">
        <p className="settings-note">
          AI features send the text of the page you&apos;re on, and what you type in the AI box, to
          Anthropic using your API key. Images, files, drawings and other pages are never sent.
          Anthropic deletes API data within 30 days and doesn&apos;t train on it without your
          permission. <ExternalLink url={PRIVACY_URL}>Anthropic&apos;s data policy</ExternalLink>
        </p>
        <Row
          label="Show AI in the editor"
          description="The Ask AI button, ⌘J, /ai and Space on an empty line"
        >
          <Toggle
            label="Show AI in the editor"
            checked={enabled}
            onChange={(value) => update({ enabled: value })}
          />
        </Row>
        <Row
          label="Anthropic API key"
          description={
            <>
              Stored encrypted on this Mac, never in your notes folder.{' '}
              <ExternalLink url={KEYS_URL}>Get a key</ExternalLink>
            </>
          }
        >
          <KeyField />
        </Row>
        <Row label="Model" description={MODEL_NOTE}>
          <Select
            label="Model"
            value={model}
            options={AI_MODELS}
            onChange={(value) => update({ model: value })}
          />
        </Row>
      </Section>
      <Section title="Usage">
        <Row
          label="This month"
          description={
            <>
              Counted on this Mac from Anthropic&apos;s reported usage. Your bill and spend limits
              are in the <ExternalLink url={CONSOLE_URL}>Anthropic Console</ExternalLink>.
            </>
          }
        >
          <span className="settings-usage">
            <span className="settings-usage-dollars">{dollars(status?.month.dollars ?? 0)}</span>
            <span className="settings-usage-requests">
              {requests === 1 ? '1 request' : `${requests} requests`}
            </span>
          </span>
        </Row>
      </Section>
    </Page>
  )
}

function ConnectionsPage(): React.JSX.Element {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void api.invoke('mcp:status', undefined).then(setStatus)
  }, [])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const change = (next: Promise<McpStatus>): void => {
    setFailed(false)
    next.then(setStatus, () => setFailed(true))
  }
  const command = status?.url && status.token ? mcpAddCommand(status.url, status.token) : null
  return (
    <Page
      title="Connections"
      description="Let Claude Code read and edit your notes while Nobsidian is open."
    >
      <Section title="Claude Code">
        <Row
          label="Let Claude Code use your notes"
          description="Claude can search, read, create and edit pages. What it replaces is kept in page history, and pages it removes go to the trash."
        >
          <Toggle
            label="Let Claude Code use your notes"
            checked={status?.enabled ?? false}
            onChange={(enabled) => change(api.invoke('mcp:setEnabled', { enabled }))}
          />
        </Row>
        {(failed || status?.error) && (
          <p className="settings-key-error" role="alert">
            {status?.error ?? "Couldn't change the connection."}
          </p>
        )}
        {command && (
          <>
            <div className="settings-connect">
              <Row
                label="Connect Claude Code"
                description="Run this once in Terminal. Claude Code sessions you start after that can use your notes."
              />
              <div className="settings-command">
                <code className="settings-command-text">{command}</code>
                <button
                  type="button"
                  className="button-secondary settings-button"
                  onClick={() =>
                    void api
                      .invoke('clipboard:writeText', { text: command })
                      .then(() => setCopied(true))
                  }
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <Row
              label="Access token"
              description="Resetting it disconnects Claude Code until you run the new command."
            >
              <button
                type="button"
                className="button-secondary settings-button"
                onClick={() => change(api.invoke('mcp:resetToken', undefined))}
              >
                Reset
              </button>
            </Row>
          </>
        )}
      </Section>
    </Page>
  )
}

const GROUPS: {
  title: string
  items: { id: SettingsSection; label: string; icon: React.JSX.Element }[]
}[] = [
  {
    title: 'Account',
    items: [{ id: 'preferences', label: 'Preferences', icon: <SlidersIcon size={20} /> }]
  },
  {
    title: 'Features',
    items: [
      { id: 'ai', label: 'AI', icon: <SparkleIcon size={20} /> },
      { id: 'connections', label: 'Connections', icon: <PlugIcon size={20} /> }
    ]
  }
]

export function SettingsModal({ section }: { section: SettingsSection }): React.JSX.Element {
  const close = (): void => useApp.getState().setOverlay(null)
  useEffect(() => {
    void useAi.getState().refresh()
  }, [])
  return (
    <Modal onClose={close} className="settings" label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {GROUPS.map((group) => (
          <div key={group.title} className="settings-nav-group">
            <div className="settings-nav-title">{group.title}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item ${item.id === section ? 'active' : ''}`}
                aria-current={item.id === section ? 'page' : undefined}
                autoFocus={item.id === section}
                onClick={() => useApp.getState().setOverlay({ kind: 'settings', section: item.id })}
              >
                <span className="settings-nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-panel">
        {section === 'preferences' ? (
          <PreferencesPage />
        ) : section === 'ai' ? (
          <AiPage />
        ) : (
          <ConnectionsPage />
        )}
      </div>
      <button type="button" className="settings-close" aria-label="Close" onClick={close}>
        <CloseIcon size={14} />
      </button>
    </Modal>
  )
}
