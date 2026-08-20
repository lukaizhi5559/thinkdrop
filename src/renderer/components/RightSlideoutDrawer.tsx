import React from 'react';

interface RightSlideoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  zIndex?: number;
}

export function RightSlideoutDrawer({
  isOpen,
  onClose,
  width = 480,
  title,
  subtitle,
  children,
  zIndex = 50,
}: RightSlideoutDrawerProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 transition-opacity duration-300 ease-out"
        style={{
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
          zIndex: zIndex - 1,
        }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed top-0 right-0 bottom-0 flex flex-col transition-transform duration-300 ease-out overflow-x-hidden"
        style={{
          width,
          maxWidth: '100%',
          backgroundColor: 'rgba(28, 28, 30, 0.98)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          zIndex,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}
        >
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-white truncate">{title}</h2>
            {subtitle && (
              <p className="text-[10px] text-gray-500 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
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
