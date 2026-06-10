/**
 * ImageCarousel - Horizontal scrollable carousel for multiple images
 * Used when content contains multiple images to display them in a nice grid/carousel layout
 */

import React, { useState, useRef, useCallback } from 'react';
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
  const [currentIndex, setCurrentIndex] = useState(0);
  const [failedImages, setFailedImages] = useState<Set<number>>(new Set());
  const [loadingImages, setLoadingImages] = useState<Set<number>>(new Set(images.map((_, i) => i)));
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleImageError = useCallback((index: number) => {
    setFailedImages(prev => new Set(prev).add(index));
    setLoadingImages(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const handleImageLoad = useCallback((index: number) => {
    setLoadedImages(prev => new Set(prev).add(index));
    setLoadingImages(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const scrollToImage = useCallback((index: number) => {
    if (scrollRef.current) {
      const scrollAmount = index * (scrollRef.current.offsetWidth * 0.85);
      scrollRef.current.scrollTo({ left: scrollAmount, behavior: 'smooth' });
    }
    setCurrentIndex(index);
  }, []);

  const handlePrev = useCallback(() => {
    const newIndex = currentIndex > 0 ? currentIndex - 1 : images.length - 1;
    scrollToImage(newIndex);
  }, [currentIndex, images.length, scrollToImage]);

  const handleNext = useCallback(() => {
    const newIndex = currentIndex < images.length - 1 ? currentIndex + 1 : 0;
    scrollToImage(newIndex);
  }, [currentIndex, images.length, scrollToImage]);

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

  if (images.length === 0) return null;

  // Single image - render without carousel chrome
  if (images.length === 1) {
    const img = images[0];
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
          src={img.src}
          alt={img.alt || ''}
          title={img.title || img.alt}
          className={`max-w-full h-auto rounded-lg shadow-lg border border-gray-600/30 cursor-pointer hover:border-blue-500/50 transition-all ${
            isLoaded ? 'opacity-100' : 'opacity-0 absolute'
          }`}
          style={{ maxHeight: `${maxHeight}px`, objectFit: 'contain' }}
          referrerPolicy="no-referrer"
          crossOrigin="anonymous"
          loading="lazy"
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
          className="flex gap-3 overflow-x-auto scrollbar-hide scroll-smooth"
          style={{ 
            scrollbarWidth: 'none', 
            msOverflowStyle: 'none',
            scrollSnapType: 'x mandatory'
          }}
        >
          {images.map((img, index) => {
            const isLoading = loadingImages.has(index);
            const isFailed = failedImages.has(index);
            const isLoaded = loadedImages.has(index);
            
            return (
              <div 
                key={`${img.src}-${index}`}
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
                      src={img.src}
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
                      crossOrigin="anonymous"
                      loading="lazy"
                      onError={() => handleImageError(index)}
                      onLoad={() => handleImageLoad(index)}
                      onClick={() => openImageInBrowser(img)}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Navigation arrows */}
        {images.length > 1 && (
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
      {images.length > 1 && (
        <div className="flex justify-center gap-1.5 mt-3">
          {images.map((img, index) => (
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
        {currentIndex + 1} / {images.length} images
      </div>
    </div>
  );
};

export default ImageCarousel;
