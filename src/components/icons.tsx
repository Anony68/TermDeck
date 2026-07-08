/**
 * Central icon mapping. The whole app imports flat UI icons from here (never
 * from 'lucide-react' directly), so the icon set can be swapped in one place and
 * the semantic name → glyph mapping stays documented.
 *
 * Lucide icons render `<svg stroke="currentColor">`, so they inherit the parent
 * element's `color`. Pass `size` (px) instead of a font size. Brand/'special'
 * marks (ClaudeIcon, CursorIcon, PresetIcon, ShellBadge) stay as their own
 * components — a generic flat set has no equivalent.
 */
export {
  Settings as IconSettings,
  RefreshCw as IconRefresh,
  ArrowUp as IconParent,
  X as IconClose,
  PanelLeft as IconSidebar,
  Search as IconSearch,
  FolderPlus as IconNewFolder,
  Folder as IconFolder,
  File as IconFile,
  Link2 as IconSymlink,
  Pin as IconPin,
  Zap as IconTemp,
  ChevronDown as IconChevronDown,
  ChevronRight as IconChevronRight,
  Play as IconPlay,
  Pause as IconPause,
  CircleStop as IconStop,
  Plus as IconPlus,
  ArrowLeftRight as IconSwap,
  Import as IconImport,
  Star as IconStar,
  Check as IconCheck,
  Clock as IconClock,
  Send as IconSend,
  Square as IconMaximize,
  Minus as IconMinimize,
  ArrowRight as IconArrowRight,
  ArrowLeft as IconArrowLeft,
} from 'lucide-react';
