import React, { useState, useRef, useCallback, useEffect } from 'react';

interface RightSlideoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  zIndex?: number;
}

const HEADER_OFFSET = 48; // UnifiedOverlay header height — drawer starts below it

export function RightSlideoutDrawer({
  isOpen,
  onClose,
  width: initialWidth = 480,
  title,
  subtitle,
  children,
  zIndex = 50,
}: RightSlideoutDrawerProps) {
  const [drawerWidth, setDrawerWidth] = useState(initialWidth);
  const [isDraggingWindow, setIsDraggingWindow] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const dragOffsetX = useRef(0);
  const dragOffsetY = useRef(0);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Forward drag to main process via window:move IPC (same as UnifiedOverlay header drag)
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const ipcRenderer = (window as any).ipcRenderer;
    if (!ipcRenderer) return;

    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffsetX.current = e.clientX - bounds.left;
    dragOffsetY.current = e.clientY - bounds.top;
    setIsDraggingWindow(true);
  }, []);

  useEffect(() => {
    if (!isDraggingWindow) return;
    const ipcRenderer = (window as any).ipcRenderer;
    if (!ipcRenderer) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = Math.round(e.screenX - dragOffsetX.current);
      const newY = Math.round(e.screenY - dragOffsetY.current);
      if (!Number.isFinite(newX) || !Number.isFinite(newY)) return;
      ipcRenderer.send('window:move', { x: newX, y: newY });
    };
    const handleMouseUp = () => {
      setIsDraggingWindow(false);
      ipcRenderer.send('window:move-done');
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingWindow]);

  // Left-edge resize handle
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    resizeStartX.current = e.screenX;
    resizeStartWidth.current = drawerWidth;
    setIsResizing(true);
  }, [drawerWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = resizeStartX.current - e.screenX;
      const newWidth = Math.max(320, Math.min(900, resizeStartWidth.current + delta));
      setDrawerWidth(newWidth);
    };
    const handleMouseUp = () => { setIsResizing(false); };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 transition-opacity duration-300 ease-out"
        style={{
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
          zIndex: zIndex - 1,
          top: `${HEADER_OFFSET}px`,
        }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed right-0 bottom-0 flex flex-col transition-transform duration-300 ease-out overflow-x-hidden"
        style={{
          top: `${HEADER_OFFSET}px`,
          width: drawerWidth,
          maxWidth: '100%',
          backgroundColor: 'rgba(28, 28, 30, 0.98)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          zIndex,
        }}
      >
        {/* Left-edge resize handle */}
        <div
          onMouseDown={handleResizeMouseDown}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-blue-500/30 transition-colors"
          style={{ zIndex: 10 }}
        />

        {/* Header — draggable to move the whole overlay window */}
        <div
          className="flex items-center gap-3 px-4 py-3 select-none"
          style={{
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            cursor: isDraggingWindow ? 'grabbing' : 'grab',
          }}
          onMouseDown={handleHeaderMouseDown}
        >
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-white truncate">{title}</h2>
            {subtitle && (
              <p className="text-[10px] text-gray-500 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors"
            style={{ color: '#9ca3af' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {children}
        </div>
      </div>
    </>
  );
}
