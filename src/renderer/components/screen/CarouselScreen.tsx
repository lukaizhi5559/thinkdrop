import { useEffect, useRef, useState } from 'react';
import '@splidejs/splide/dist/css/splide.min.css';
import type { ScreenOutput, ScreenImage } from './types';
import { MOOD_ACCENT } from './types';
import { EmojiGlyph } from './EmojiGlyph';

/**
 * CarouselScreen — kind:'image' with images[] (2+): a Splide carousel card.
 *
 * Splide is lazy-imported so the ~30KB slider only loads for multi-image
 * displays. Slides are full-bleed images on a dimmed card; arrows + dots +
 * drag/swipe are native Splide chrome (the display posts interactive:true so
 * hovering the card lifts click-through and pointer input lands), and ←/→
 * ride the capability → global-shortcut pipeline ('screen:deck-nav').
 *
 * Local paths arrive as dataUrl already — main.js rewrites images[].path
 * before forwarding (the ghost window can't reach the filesystem).
 */

function itemSrc(it: ScreenImage): string | null {
  return it.dataUrl || it.url || null;
}

export function CarouselScreen({ output, animateClass }: { output: ScreenOutput; animateClass: string }) {
  const accent = MOOD_ACCENT[output.mood] || MOOD_ACCENT.neutral;
  const items = (output.images || []).filter(it => itemSrc(it));
  const hostRef = useRef<HTMLDivElement>(null);
  const splideRef = useRef<any>(null);
  const [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);

  // Mount Splide once the slides exist. destroy() on unmount/output swap.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || items.length === 0) return;
    let disposed = false;
    (async () => {
      let Splide: any;
      try {
        Splide = (await import('@splidejs/splide')).Splide;
      } catch {
        if (!disposed) setFailed(true);
        return;
      }
      if (disposed || !hostRef.current) return;
      const splide = new Splide(hostRef.current!.querySelector('.splide'), {
        type: items.length > 1 ? 'loop' : 'slide',
        autoplay: items.length > 1 && (output.durationMs || 0) !== 0,
        interval: 4500,
        pauseOnHover: true,
        pauseOnFocus: true,
        arrows: items.length > 1,
        pagination: items.length > 1,
        keyboard: false, // keys ride the global-shortcut pipeline instead
        height: 'min(62vh, 560px)',
        cover: output.fit === 'cover',
        gap: '0px',
      });
      splide.on('move', (i: number) => setIndex(i));
      splide.mount();
      splideRef.current = splide;
    })().catch(() => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
      try { splideRef.current?.destroy(); } catch (_) {}
      splideRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output.id]);

  // ←/→ nav via the deck-nav channel (arrowNav capability is sniffed at
  // POST time — images[].length > 1 registers the arrows).
  useEffect(() => {
    const onNav = (e: Event) => {
      const dir = (e as CustomEvent).detail?.dir;
      if (dir === 'prev') splideRef.current?.go('<');
      else if (dir === 'next') splideRef.current?.go('>');
    };
    window.addEventListener('screen:deck-nav', onNav);
    return () => window.removeEventListener('screen:deck-nav', onNav);
  }, []);

  if (items.length === 0) return null;
  const caption = items[index]?.caption || output.caption || output.title;

  return (
    <div
      className={animateClass}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
        maxWidth: '86vw',
        padding: 24,
        borderRadius: 24,
        background: 'rgba(8, 12, 20, 0.55)',
        border: `1px solid ${accent}44`,
        boxShadow: `0 8px 60px rgba(0,0,0,0.5), 0 0 40px ${accent}22`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      {output.emoji && <EmojiGlyph emoji={output.emoji} accent={accent} size={56} />}
      {failed ? (
        // Graceful fallback: first image as a static card.
        <img
          src={itemSrc(items[0])!}
          alt={caption || ''}
          style={{ maxWidth: '78vw', maxHeight: '60vh', objectFit: 'contain', borderRadius: 14 }}
        />
      ) : (
        <div ref={hostRef} style={{ width: 'min(78vw, 980px)' }}>
          <div className="splide" style={{ width: '100%' }}>
            <div className="splide__track" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <ul className="splide__list">
                {items.map((it, i) => (
                  <li className="splide__slide" key={i}>
                    <img
                      src={itemSrc(it)!}
                      alt={it.caption || `${i + 1}`}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: output.fit === 'cover' ? 'cover' : 'contain',
                        background: 'rgba(0,0,0,0.35)',
                      }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {caption && (
        <div
          style={{
            color: '#e5e7eb',
            fontSize: 18,
            fontWeight: 600,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            textAlign: 'center',
            maxWidth: '70vw',
          }}
        >
          {caption}
          {items.length > 1 && (
            <span style={{ marginLeft: 10, fontSize: 13, color: '#94a3b8', fontWeight: 500 }}>
              {index + 1} / {items.length}
            </span>
          )}
        </div>
      )}
      {/* Splide chrome needs pointer input — the display posts
          interactive:true so hovering the card captures it. */}
      <style>{`
        .splide__arrow { background: rgba(10,14,22,0.72) !important; }
        .splide__arrow svg { fill: #e5e7eb !important; }
        .splide__pagination__page { background: rgba(148,163,184,0.4) !important; }
        .splide__pagination__page.is-active { background: ${accent} !important; }
      `}</style>
    </div>
  );
}
