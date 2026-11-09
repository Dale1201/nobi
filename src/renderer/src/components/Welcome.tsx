import { useApp } from '../store'

export function Welcome(): React.JSX.Element {
  const missing = useApp((s) => s.settings?.lastWorkspace)
  return (
    <div className="main drag-region">
      <div className="welcome no-drag">
        {missing ? (
          <>
            <h1>Can&apos;t find your notes</h1>
            <p>
              Nobi couldn&apos;t find the folder <strong>{missing}</strong>. It may have been moved,
              renamed, or be on a drive that isn&apos;t connected.
            </p>
          </>
        ) : (
          <>
            <h1>Welcome to Nobi</h1>
            <p>
              Your notes live as Markdown files in a folder you choose. Pick an empty folder to
              start fresh, or one that already has notes.
            </p>
          </>
        )}
        <button className="button-primary" onClick={() => void useApp.getState().chooseWorkspace()}>
          {missing ? 'Locate folder' : 'Choose a folder'}
        </button>
      </div>
    </div>
  )
}
