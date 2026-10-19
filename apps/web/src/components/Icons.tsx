import type { ReactNode } from "react";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const SunIcon = () => (<Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>);
export const MoonIcon = () => (<Svg><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></Svg>);
export const MonitorIcon = () => (<Svg><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></Svg>);
export const CopyIcon = () => (<Svg><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15V5a1 1 0 0 1 1-1h9" /></Svg>);
export const CheckIcon = () => (<Svg><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>);
export const XCircleIcon = () => (<Svg><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></Svg>);
export const MenuIcon = () => (<Svg><path d="M4 7h16M4 12h16M4 17h16" /></Svg>);
export const CloseIcon = () => (<Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>);
export const InfoIcon = () => (<Svg><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>);
export const ClockIcon = () => (<Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>);
export const TriangleIcon = () => (<Svg><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5M12 18h.01" /></Svg>);
export const HomeIcon = () => (<Svg><path d="M4 11l8-7 8 7v9H4z" /></Svg>);
export const WrenchIcon = () => (<Svg><path d="M14.5 6.5a4 4 0 0 0 5 5L10 21l-4-4 9.5-9.5z" /></Svg>);
export const ChartIcon = () => (<Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>);
export const BookIcon = () => (<Svg><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z" /><path d="M5 17a3 3 0 0 1 3-3h11" /></Svg>);
export const UserIcon = () => (<Svg><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>);
export const MinusCircleIcon = () => (<Svg><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></Svg>);
export const KeyIcon = () => (<Svg><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3" /></Svg>);
export const ShieldIcon = () => (<Svg><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /></Svg>);
export const WalletIcon = () => (<Svg><path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M3 7l12-3v3M16 13h3" /></Svg>);
export const ListIcon = () => (<Svg><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></Svg>);
export const GridIcon = () => (<Svg><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></Svg>);
export const MoreIcon = () => (<Svg><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></Svg>);
