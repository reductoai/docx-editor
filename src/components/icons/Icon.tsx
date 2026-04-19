import {
  Sparkles,
  FileText,
  Send,
  Plus,
  Mic,
  Link as LinkIcon,
  Check,
  X,
  Search,
  Pencil,
  GitCompare,
  Bookmark,
  CornerDownLeft,
  RefreshCw,
  MoreHorizontal,
  AtSign,
  Square,
  Shield,
  Clock,
  Zap,
  ArrowRight,
  ChevronDown,
  Copy,
  Pin,
  Paperclip,
  type LucideProps,
} from "lucide-react";

// Map of design-token icon names to Lucide components.
// Kept in sync with the CI icon set in design/editor/project/chat.jsx.
const ICONS = {
  sparkles: Sparkles,
  file: FileText,
  send: Send,
  plus: Plus,
  mic: Mic,
  link: LinkIcon,
  check: Check,
  x: X,
  search: Search,
  edit: Pencil,
  diff: GitCompare,
  bookmark: Bookmark,
  corner: CornerDownLeft,
  refresh: RefreshCw,
  more: MoreHorizontal,
  atsign: AtSign,
  stop: Square,
  shield: Shield,
  clock: Clock,
  zap: Zap,
  arrow: ArrowRight,
  caret: ChevronDown,
  copy: Copy,
  pin: Pin,
  paperclip: Paperclip,
} as const;

export type IconName = keyof typeof ICONS;

export interface IconProps extends Omit<LucideProps, "ref"> {
  name: IconName;
  size?: number;
}

export default function Icon({ name, size = 14, strokeWidth = 1.5, ...rest }: IconProps) {
  const Cmp = ICONS[name] ?? Zap;
  return <Cmp size={size} strokeWidth={strokeWidth} {...rest} />;
}
