/**
 * ImageCarousel - Horizontal scrollable carousel for multiple images
 * Used when content contains multiple images to display them in a nice grid/carousel layout
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import './ImageCarousel.css';

export interface ImageItem {
  src: string;
  alt?: string;
  title?: string;
  originalUrl?: string; // Optional original source URL for click-to-view
}

interface ImageCarouselProps {
  images: ImageItem[];
  maxHeight?: number;
}

export const ImageCarousel: React.FC<ImageCarouselProps> = ({ 
  images, 
  maxHeight = 300 
}) => {
  // Reset keyed on the serialized src set — NOT the array identity. Callers
  // rebuild `images` on every render (the feed re-renders on each stream tick),
  // so identity-based resets wiped load state mid-flight and, since onLoad
  // never refires on an already-mounted <img>, left permanent skeletons.
  const imagesKey = images.map(i => i.src).join('\u0001');
  // Dedupe identical srcs — the same photo can surface twice via differing
  // escaped/parameterized URLs upstream.
  const dedupedImages = useMemo(() => {
    const seen = new Set<string>();
    return images.filter(i => !!i.src && (seen.has(i.src) ? false : (seen.add(i.src), true)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesKey]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [failedImages, setFailedImages] = useState<Set<number>>(new Set());
  const [loadingImages, setLoadingImages] = useState<Set<number>>(new Set(dedupedImages.map((_, i) => i)));
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());
  // Per-image src overrides — onError retries once with originalUrl when it
  // differs (thumbnail hotlink-blocked → try the full-size source).
  const [srcOverride, setSrcOverride] = useState<Map<number, string>>(new Map());
  const retriedRef = useRef<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state only when the actual src set changes (new result set arrived)
  useEffect(() => {
    setCurrentIndex(0);
    setFailedImages(new Set());
    setLoadingImages(new Set(dedupedImages.map((_, i) => i)));
    setLoadedImages(new Set());
    setSrcOverride(new Map());
    retriedRef.current = new Set();
    // Watchdog — an image that neither loads nor errors within 12s is marked
    // failed so the skeleton doesn't linger forever (e.g. lazy/clipped loads).
    const watchdog = setTimeout(() => {
      setLoadingImages(prev => {
        if (prev.size === 0) return prev;
        const stuck = [...prev];
        setFailedImages(f => new Set([...f, ...stuck]));
        return new Set();
      });
    }, 12000);
    return () => clearTimeout(watchdog);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesKey]);

  const handleImageError = useCallback((index: number) => {
    const img = dedupedImages[index];
    if (img?.originalUrl && img.originalUrl !== img.src && !retriedRef.current.has(index)) {
      retriedRef.current.add(index);
      setSrcOverride(prev => new Map(prev).set(index, img.originalUrl!));
      return; // stays in loadingImages — the retried src will fire load/error
    }
    setFailedImages(prev => new Set(prev).add(index));
    setLoadingImages(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, [dedupedImages]);

  const handleImageLoad = useCallback((index: number) => {
    setLoadedImages(prev => new Set(prev).add(index));
    setLoadingImages(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const scrollToImage = useCallback((index: number) => {
    if (scrollRef.current && itemRefs.current[index]) {
      // Scroll to the actual item element's offset, not an estimated width
      const target = itemRefs.current[index];
      const left = target.offsetLeft - 8;
      scrollRef.current.scrollTo({ left, behavior: 'smooth' });
    }
    setCurrentIndex(index);
  }, []);

  // Track manual scrolling to sync currentIndex with dots/counter
  const handleScroll = useCallback(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      if (!scrollRef.current) return;
      const scrollLeft = scrollRef.current.scrollLeft;
      let nearest = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < itemRefs.current.length; i++) {
        const el = itemRefs.current[i];
        if (!el) continue;
        const dist = Math.abs(el.offsetLeft - 8 - scrollLeft);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = i;
        }
      }
      setCurrentIndex(nearest);
    }, 80);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const handlePrev = useCallback(() => {
    const newIndex = currentIndex > 0 ? currentIndex - 1 : dedupedImages.length - 1;
    scrollToImage(newIndex);
  }, [currentIndex, dedupedImages.length, scrollToImage]);

  const handleNext = useCallback(() => {
    const newIndex = currentIndex < dedupedImages.length - 1 ? currentIndex + 1 : 0;
    scrollToImage(newIndex);
  }, [currentIndex, dedupedImages.length, scrollToImage]);

  const openImageInBrowser = useCallback((image: ImageItem) => {
    // Use original source URL if available, otherwise use the src (thumbnail)
    const urlToOpen = image.originalUrl || image.src;
    const ipcRenderer = (window as any).electron?.ipcRenderer;
    if (ipcRenderer) {
      ipcRenderer.send('shell:open-url', urlToOpen);
    } else {
      window.open(urlToOpen, '_blank');
    }
  }, []);

  if (dedupedImages.length === 0) return null;

  // Single image - render without carousel chrome
  if (dedupedImages.length === 1) {
    const img = dedupedImages[0];
    const isLoading = loadingImages.has(0);
    const isFailed = failedImages.has(0);
    const isLoaded = loadedImages.has(0);
    
    if (isFailed) {
      return (
        <div 
          className="my-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm cursor-pointer hover:bg-yellow-500/20 transition-colors"
          onClick={() => openImageInBrowser(img)}
          title={img.src}
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Failed to load image - click to open in browser
          </div>
        </div>
      );
    }

    return (
      <div className="my-4 max-w-full">
        {/* Skeleton placeholder - shown while loading */}
        {isLoading && !isLoaded && (
          <div 
            className="image-skeleton rounded-lg border border-gray-600/30"
            style={{ maxHeight: `${maxHeight}px`, minHeight: '150px' }}
          />
        )}
        
        <img
          src={srcOverride.get(0) || img.src}
          alt={img.alt || ''}
          title={img.title || img.alt}
          className={`max-w-full h-auto rounded-lg shadow-lg border border-gray-600/30 cursor-pointer hover:border-blue-500/50 transition-all ${
            isLoaded ? 'opacity-100' : 'opacity-0 absolute'
          }`}
          style={{ maxHeight: `${maxHeight}px`, objectFit: 'contain' }}
          referrerPolicy="no-referrer"
          onError={() => handleImageError(0)}
          onLoad={() => handleImageLoad(0)}
          onClick={() => openImageInBrowser(img)}
        />
        {(img.alt || img.title) && (
          <div className="text-xs text-gray-400 mt-1 italic text-center">
            {img.alt || img.title}
          </div>
        )}
      </div>
    );
  }

  // Multiple images - carousel view
  return (
    <div className="my-4 w-full">
      {/* Main carousel area */}
      <div className="relative group">
        {/* Scrollable container */}
        <div 
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex gap-3 overflow-x-auto scrollbar-hide scroll-smooth"
          style={{ 
            scrollbarWidth: 'none', 
            msOverflowStyle: 'none',
            scrollSnapType: 'x mandatory'
          }}
        >
          {dedupedImages.map((img, index) => {
            const isLoading = loadingImages.has(index);
            const isFailed = failedImages.has(index);
            const isLoaded = loadedImages.has(index);
            
            return (
              <div 
                key={`${img.src}-${index}`}
                ref={(el) => { itemRefs.current[index] = el; }}
                className="flex-shrink-0 scroll-snap-align-start relative"
                style={{ scrollSnapAlign: 'start' }}
              >
                {isFailed ? (
                  <div 
                    className="flex items-center justify-center w-64 h-48 rounded-lg bg-gray-800/50 border border-gray-600/30 cursor-pointer hover:border-yellow-500/50 hover:bg-yellow-500/10 transition-colors"
                    onClick={() => openImageInBrowser(img)}
                    title={img.src}
                  >
                    <div className="text-center text-yellow-400/70 text-xs p-4">
                      <svg className="mx-auto mb-2" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                      Click to view
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Skeleton placeholder - shown while loading */}
                    {isLoading && !isLoaded && (
                      <div 
                        className="image-skeleton rounded-lg border border-gray-600/30"
                        style={{ 
                          maxHeight: `${maxHeight}px`,
                          maxWidth: '300px',
                          minWidth: '250px',
                          minHeight: '180px'
                        }}
                      />
                    )}
                    
                    <img
                      src={srcOverride.get(index) || img.src}
                      alt={img.alt || ''}
                      title={img.title || img.alt}
                      className={`rounded-lg shadow-lg border border-gray-600/30 cursor-pointer hover:border-blue-500/50 transition-all hover:shadow-xl ${
                        isLoaded ? 'opacity-100' : 'opacity-0 absolute'
                      }`}
                      style={{ 
                        maxHeight: `${maxHeight}px`, 
                        maxWidth: '300px',
                        height: 'auto',
                        objectFit: 'contain'
                      }}
                      referrerPolicy="no-referrer"
                      onError={() => handleImageError(index)}
                      onLoad={() => handleImageLoad(index)}
                      onClick={() => openImageInBrowser(img)}
                    />
                    {/* Caption under each thumbnail (not just single-image) */}
                    {(img.alt || img.title) && (
                      <div className="text-xs text-gray-400 mt-1 italic text-center" style={{ maxWidth: '300px' }}>
                        {img.alt || img.title}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Navigation arrows */}
        {dedupedImages.length > 1 && (
          <>
            <button
              onClick={handlePrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 border border-white/20 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80 transition-all z-10"
              aria-label="Previous image"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              onClick={handleNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 border border-white/20 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80 transition-all z-10"
              aria-label="Next image"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Thumbnail navigation */}
      {dedupedImages.length > 1 && (
        <div className="flex justify-center gap-1.5 mt-3">
          {dedupedImages.map((_img, index) => (
            <button
              key={`thumb-${index}`}
              onClick={() => scrollToImage(index)}
              className={`w-2 h-2 rounded-full transition-all ${
                index === currentIndex 
                  ? 'bg-blue-500 w-4' 
                  : 'bg-gray-500/50 hover:bg-gray-400'
              }`}
              aria-label={`Go to image ${index + 1}`}
            />
          ))}
        </div>
      )}

      {/* Image counter */}
      <div className="text-center text-xs text-gray-500 mt-2">
        {currentIndex + 1} / {dedupedImages.length} images
      </div>
    </div>
  );
};

export default ImageCarousel;
