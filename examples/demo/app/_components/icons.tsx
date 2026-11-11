import type { ReactNode, SVGProps } from 'react';

/**
 * The demo's icon set: drawn here on a 24-unit grid, one stroke weight, no icon font and no Unicode stand-ins
 * (the brand fonts are subset to Latin, so glyphs such as arrows would fall back).
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, strokeWidth = 1.75, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ArrowUpRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7 17 17 7M8 7h9v9" />
  </Icon>
);

export const ExternalLink = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const Copy = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </Icon>
);

export const Check = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const LockOpen = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="11" width="16" height="10" rx="1.5" />
    <path d="M8 11V7.5a4 4 0 0 1 7.7-1.5" />
  </Icon>
);

export const LifeBuoy = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="m5.6 5.6 3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9" />
  </Icon>
);

export const Download = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v11M7 10.5l5 5 5-5M4 20h16" />
  </Icon>
);

export const AppWindow = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01" />
  </Icon>
);

export const ShieldCheck = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 5 6v5.5c0 4.3 2.9 7.9 7 9.5 4.1-1.6 7-5.2 7-9.5V6l-7-3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
);

export const RotateCw = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 5v5h-5" />
    <path d="M19.4 14.5A8 8 0 1 1 18 7.4L20 10" />
  </Icon>
);

export const AlertTriangle = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Icon>
);

export const Info = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Icon>
);

export const CheckCircle = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.2 12.3 2.6 2.6 5-5.3" />
  </Icon>
);

export const Split = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
    <rect x="8.25" y="13.5" width="7.5" height="7.5" rx="1" />
  </Icon>
);

export const Fingerprint = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.5 6.2A8 8 0 0 1 20 12v1.5" />
    <path d="M4 12a8 8 0 0 1 .7-3.3" />
    <path d="M8 12a4 4 0 0 1 8 0v1c0 2.4.5 4.6 1.5 6.5" />
    <path d="M12 12v1.5c0 3 .9 5.4 2.3 7.5" />
    <path d="M8.2 15.5c.3 1.9 1 3.7 2 5.3" />
    <path d="M4.3 15.5c.4 1.3.9 2.6 1.6 3.7" />
  </Icon>
);

export const Layers = (props: IconProps) => (
  <Icon {...props}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12.5 9 5 9-5M3 17l9 5 9-5" />
  </Icon>
);

export const FileKey = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5Z" />
    <path d="M14 3v5h5" />
    <circle cx="10" cy="14" r="2" />
    <path d="M12 14h4M14.5 14v2" />
  </Icon>
);

export const Code = (props: IconProps) => (
  <Icon {...props}>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />
  </Icon>
);

export const LogOut = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4H9M15.5 16.5 20 12l-4.5-4.5M20 12H9" />
  </Icon>
);
