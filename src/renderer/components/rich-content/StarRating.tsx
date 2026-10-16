/**
 * StarRating — compact SVG star row for SERP rich snippets.
 * Renders `value`/`max` as filled/half/outline stars plus optional review
 * count and price-range chip. Used by WebResultCard for rating-annotated
 * results (restaurants, products, services).
 */

import React from 'react';

interface StarRatingProps {
  value: number;
  max?: number;
  count?: number;
  priceRange?: string;
  size?: number;
}

const STAR_PATH =
  'M12 2.6l2.6 5.6 6 .7-4.5 4.1 1.2 5.9L12 15.9l-5.3 3-1.2-5.9L1 8.9l6-.7L12 2.6z';

const StarRating: React.FC<StarRatingProps> = ({ value, max = 5, count, priceRange, size = 11 }) => {
  const uid = React.useId();
  const stars = Array.from({ length: max }, (_, i) => {
    const fill = Math.max(0, Math.min(1, value - i)); // 1 full, 0.5-ish half, 0 empty
    return { i, fill };
  });
  const fmtCount = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ display: 'inline-flex', gap: 1 }}>
        {stars.map(({ i, fill }) => (
          <svg key={i} width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id={`sr${uid}-${i}`}>
                <stop offset={`${fill * 100}%`} stopColor="#fbbf24" />
                <stop offset={`${fill * 100}%`} stopColor="rgba(255,255,255,0.18)" />
              </linearGradient>
            </defs>
            <path d={STAR_PATH} fill={`url(#sr${uid}-${i})`} />
          </svg>
        ))}
      </span>
      <span style={{ fontSize: 10, fontWeight: 600, color: '#fbbf24' }}>
        {value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}
      </span>
      {typeof count === 'number' && count > 0 && (
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>
          ({fmtCount(count)})
        </span>
      )}
      {priceRange && (
        <span style={{ fontSize: 9, fontWeight: 600, color: '#4ade80' }}>
          {priceRange}
        </span>
      )}
    </span>
  );
};

export default StarRating;
