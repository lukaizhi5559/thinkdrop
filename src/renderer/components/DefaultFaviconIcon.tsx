import React, { useEffect, useState } from 'react';

interface DefaultFaviconIconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function DefaultFaviconIcon({ size = 16, className, style }: DefaultFaviconIconProps) {
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: '#3b82f6',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...style,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    </div>
  );
}

interface FaviconProps {
  domain?: string;
  src?: string;
  size?: number;
  alt?: string;
  style?: React.CSSProperties;
  imgStyle?: React.CSSProperties;
  className?: string;
}

export function Favicon({ domain, src, size = 16, alt = '', style, imgStyle, className }: FaviconProps) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // Reject invalid hostnames (underscores are not valid in DNS, etc.) — Google's
  // favicon service would return its default globe image for these, so skip
  // straight to the DefaultFaviconIcon fallback.
  const isValidHostname = (d: string) =>
    !d.includes('_') && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d);

  const url =
    src ||
    (domain && isValidHostname(domain)
      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${Math.min(128, Math.max(size * 4, 64))}`
      : '');

  useEffect(() => {
    setIconUrl(null);
    setError(false);
    if (!url) {
      setError(true);
      return;
    }
    const img = new Image();
    img.onload = () => setIconUrl(url);
    img.onerror = () => setError(true);
    img.src = url;
  }, [url]);

  if (!iconUrl || error) {
    return <DefaultFaviconIcon size={size} className={className} style={style} />;
  }

  return (
    <img
      src={iconUrl}
      alt={alt}
      width={size}
      height={size}
      className={className}
      style={{ borderRadius: 2, flexShrink: 0, display: 'block', ...style, ...imgStyle }}
      onError={() => setError(true)}
    />
  );
}
