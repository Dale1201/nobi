import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
      focusable={false}
      {...rest}
    >
      {children}
    </svg>
  )
}

export const ChevronRightIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7.4 4.6a.75.75 0 0 1 1.06 0l4.87 4.87a.75.75 0 0 1 0 1.06L8.46 15.4a.75.75 0 1 1-1.06-1.06L11.74 10 7.4 5.66a.75.75 0 0 1 0-1.06Z" />
  </Svg>
)

export const ChevronLeftIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12.6 4.6a.75.75 0 0 0-1.06 0L6.67 9.47a.75.75 0 0 0 0 1.06l4.87 4.87a.75.75 0 1 0 1.06-1.06L8.26 10l4.34-4.34a.75.75 0 0 0 0-1.06Z" />
  </Svg>
)

export const OpenInTabIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3.25" y="4.25" width="13.5" height="11.5" rx="1.75" {...stroke} />
    <path d="M3.5 7.75h13M8 4.5v3" {...stroke} />
  </Svg>
)

export const BacklinkIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M6 14 14 6M8 6h6v6" {...stroke} />
  </Svg>
)

export const PlusIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M10 3.75a.75.75 0 0 1 .75.75v4.75h4.75a.75.75 0 0 1 0 1.5h-4.75v4.75a.75.75 0 0 1-1.5 0v-4.75H4.5a.75.75 0 0 1 0-1.5h4.75V4.5a.75.75 0 0 1 .75-.75Z" />
  </Svg>
)

export const DotsIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="4.5" cy="10" r="1.5" />
    <circle cx="10" cy="10" r="1.5" />
    <circle cx="15.5" cy="10" r="1.5" />
  </Svg>
)

export const StarIcon = ({ filled, ...p }: IconProps & { filled?: boolean }): React.JSX.Element => (
  <Svg {...p}>
    <path
      d="M10 2.9l2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.7 5.7 16l.9-4.8L3.1 7.9l4.8-.6L10 2.9Z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </Svg>
)

export const PageIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path
      d="M5.5 2.75h5.69c.2 0 .39.08.53.22l3.31 3.31c.14.14.22.33.22.53v9.44c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25V4c0-.69.56-1.25 1.25-1.25Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <path
      d="M7 10h6M7 12.75h6M7 7.25h3"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </Svg>
)

export const ComposeIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4.75 5.5c0-.41.34-.75.75-.75h4a.75.75 0 0 0 0-1.5h-4A2.25 2.25 0 0 0 3.25 5.5v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-4a.75.75 0 0 0-1.5 0v4c0 .41-.34.75-.75.75h-9a.75.75 0 0 1-.75-.75v-9Z" />
    <path d="M14.47 2.97a1.75 1.75 0 0 1 2.48 2.48l-6.2 6.2-3.1.62.62-3.1 6.2-6.2Z" />
  </Svg>
)

export const SmileIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="7.75" cy="8.5" r="1" />
    <circle cx="12.25" cy="8.5" r="1" />
    <path
      d="M7.25 11.75c.6.9 1.6 1.5 2.75 1.5s2.15-.6 2.75-1.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </Svg>
)

export const ImageIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect
      x="3.25"
      y="4.25"
      width="13.5"
      height="11.5"
      rx="1.75"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <circle cx="7.5" cy="8.25" r="1.25" />
    <path
      d="M4 14.5l3.75-3.75 2.5 2.5 2-2 3.75 3.75"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </Svg>
)

export const SidebarIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect
      x="3.25"
      y="4.25"
      width="13.5"
      height="11.5"
      rx="1.75"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M8 4.5v11" stroke="currentColor" strokeWidth="1.4" />
  </Svg>
)

export const TrashIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path
      d="M8 3.25h4M4.5 5.75h11M6 5.75l.6 9.1c.05.79.7 1.4 1.5 1.4h3.8c.8 0 1.45-.61 1.5-1.4l.6-9.1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </Svg>
)

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export const SearchIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="8.75" cy="8.75" r="5" {...stroke} />
    <path d="m12.5 12.5 4 4" {...stroke} />
  </Svg>
)

export const MoveIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4.25 4.5v4.25a3 3 0 0 0 3 3h9" {...stroke} />
    <path d="m13 8.25 3.25 3.5L13 15.25" {...stroke} />
  </Svg>
)

export const RenameIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12.75 4.25 15.75 7.25 7.5 15.5H4.5v-3l8.25-8.25Z" {...stroke} />
  </Svg>
)

export const RestoreIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 8.25h7.25a3.75 3.75 0 0 1 0 7.5H9" {...stroke} />
    <path d="M7.75 5.5 5 8.25 7.75 11" {...stroke} />
  </Svg>
)

export const ClockIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="6.75" {...stroke} />
    <path d="M10 6.25V10l2.5 1.75" {...stroke} />
  </Svg>
)

export const CloseIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m5.5 5.5 9 9m0-9-9 9" {...stroke} />
  </Svg>
)

export const WidthIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 10h14M6 7l-3 3 3 3M14 7l3 3-3 3" {...stroke} />
  </Svg>
)

export const DuplicateIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="7" y="7" width="9.25" height="9.25" rx="2" {...stroke} />
    <path
      d="M13 4.75A1.75 1.75 0 0 0 11.25 3h-6.5A1.75 1.75 0 0 0 3 4.75v6.5A1.75 1.75 0 0 0 4.75 13"
      {...stroke}
    />
  </Svg>
)

export const TocIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7 5h9.5M9.5 10h7M9.5 15h7" {...stroke} />
    <circle cx="3.75" cy="5" r="1" />
    <circle cx="6.25" cy="10" r="1" />
    <circle cx="6.25" cy="15" r="1" />
  </Svg>
)

export const ChevronDownIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4.6 7.4a.75.75 0 0 1 1.06 0L10 11.74l4.34-4.34a.75.75 0 1 1 1.06 1.06l-4.87 4.87a.75.75 0 0 1-1.06 0L4.6 8.46a.75.75 0 0 1 0-1.06Z" />
  </Svg>
)

export const DragIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="7.5" cy="5" r="1.3" />
    <circle cx="12.5" cy="5" r="1.3" />
    <circle cx="7.5" cy="10" r="1.3" />
    <circle cx="12.5" cy="10" r="1.3" />
    <circle cx="7.5" cy="15" r="1.3" />
    <circle cx="12.5" cy="15" r="1.3" />
  </Svg>
)

export const TurnIntoIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 7.25A3.25 3.25 0 0 1 7.25 4h6.69l-1.47-1.47a.75.75 0 1 1 1.06-1.06l2.75 2.75a.75.75 0 0 1 0 1.06l-2.75 2.75a.75.75 0 1 1-1.06-1.06l1.47-1.47H7.25A1.75 1.75 0 0 0 5.5 7.25v1a.75.75 0 0 1-1.5 0v-1Zm12 5.5A3.25 3.25 0 0 1 12.75 16H6.06l1.47 1.47a.75.75 0 1 1-1.06 1.06l-2.75-2.75a.75.75 0 0 1 0-1.06l2.75-2.75a.75.75 0 1 1 1.06 1.06L6.06 14.5h6.69a1.75 1.75 0 0 0 1.75-1.75v-1a.75.75 0 0 1 1.5 0v1Z" />
  </Svg>
)

export const PaletteIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M10 3a7 7 0 0 0 0 14c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01a1.5 1.5 0 0 1 1.12-2.49H14a3 3 0 0 0 3-3C17 5.69 13.87 3 10 3Zm-4 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm2-3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm4 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
  </Svg>
)

export const CalloutIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 3.5h10A2.5 2.5 0 0 1 17.5 6v6a2.5 2.5 0 0 1-2.5 2.5H9.6l-3.4 2.55A.75.75 0 0 1 5 16.45V14.5A2.5 2.5 0 0 1 2.5 12V6A2.5 2.5 0 0 1 5 3.5Zm0 1.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.75a.75.75 0 0 1 .75.75v1.2l2.55-1.9a.75.75 0 0 1 .45-.15H15a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H5Zm1.75 2.5h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5Zm0 2.5h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z" />
  </Svg>
)

export const DrawingIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M14.2 2.9a1.9 1.9 0 0 1 2.7 2.7l-8.6 8.6a2 2 0 0 1-.9.5l-3 .8a.6.6 0 0 1-.7-.7l.8-3a2 2 0 0 1 .5-.9l8.6-8.6Zm1.6 1.1a.4.4 0 0 0-.5 0l-1 1 .5.5 1-1a.4.4 0 0 0 0-.5Zm-2 2.1-.5-.5-6.6 6.6a.5.5 0 0 0-.1.2l-.4 1.4 1.4-.4.2-.1 6.6-6.6-.6-.6ZM3 17.25c0-.4.3-.75.75-.75h12.5a.75.75 0 0 1 0 1.5H3.75a.75.75 0 0 1-.75-.75Z" />
  </Svg>
)

export const SettingsIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path
      d="M8.6 2.75h2.8l.45 2 1.55.9 1.95-.62 1.4 2.42-1.5 1.38v1.78l1.5 1.38-1.4 2.42-1.95-.62-1.55.9-.45 2H8.6l-.45-2-1.55-.9-1.95.62-1.4-2.42 1.5-1.38V9.83l-1.5-1.38 1.4-2.42 1.95.62 1.55-.9.45-2Z"
      {...stroke}
    />
    <circle cx="10" cy="10" r="2.4" {...stroke} />
  </Svg>
)

export const SparkleIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M10 2.5c.45 3.9 1.65 5.1 5.5 5.55-3.85.45-5.05 1.65-5.5 5.55-.45-3.9-1.65-5.1-5.5-5.55 3.85-.45 5.05-1.65 5.5-5.55Z" />
    <path d="M15.25 12.5c.2 1.6.7 2.1 2.25 2.3-1.55.2-2.05.7-2.25 2.3-.2-1.6-.7-2.1-2.25-2.3 1.55-.2 2.05-.7 2.25-2.3Z" />
  </Svg>
)

export const ArrowUpIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" {...stroke} strokeWidth={1.8} />
  </Svg>
)

export const StopIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="7" height="7" rx="1.5" />
  </Svg>
)

export const CheckIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m5 10.5 3.25 3.25L15 7" {...stroke} strokeWidth={1.8} />
  </Svg>
)

export const UndoIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7.5 5 4.5 8l3 3M4.75 8h6.5a3.75 3.75 0 0 1 0 7.5H9" {...stroke} />
  </Svg>
)

export const PlugIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7.5 3v3.5M12.5 3v3.5M5.5 6.5h9v3a4.5 4.5 0 0 1-9 0v-3ZM10 14v3" {...stroke} />
  </Svg>
)

export const SlidersIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3.5 6h6M13.5 6h3M3.5 14h3M10.5 14h6" {...stroke} />
    <circle cx="11.5" cy="6" r="2" {...stroke} />
    <circle cx="8.5" cy="14" r="2" {...stroke} />
  </Svg>
)
