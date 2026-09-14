import React from 'react';
import { TabBar, type TabId } from './TabComponents';
import { ThinkDropLogo } from './SlideoutDrawer';
import type { RefObject } from 'react';

interface OverlayHeaderProps {
  headerRef: RefObject<HTMLDivElement>;
  isDragging: boolean;
  isExpanded: boolean;
  showCopyButton: boolean;
  isCopied: boolean;
  activeTab: string;
  queueCount: number;
  cronCount: number;
  unreadTabs: Set<TabId>;
  onToggleWidth: () => void;
  onCopy: () => void;
  onClose: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onToggleSlideout: () => void;
  onTabSelect: (tab: TabId | 'settings' | 'rules') => void;
}

function OverlayHeaderImpl({
  headerRef,
  isDragging,
  isExpanded,
  showCopyButton,
  isCopied,
  activeTab,
  queueCount,
  cronCount,
  unreadTabs,
  onToggleWidth,
  onCopy,
  onClose,
  onMouseDown,
  onToggleSlideout,
  onTabSelect,
}: OverlayHeaderProps) {
  return (
    <div
      ref={headerRef}
      className="flex flex-col"
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
      }}
    >
      {/* Row 1: Hamburger + Logo (centered) + Action Buttons */}
      <div className="flex items-center justify-between px-4 py-2 relative">
        {/* Left: Hamburger Menu */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSlideout();
          }}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors"
          style={{ color: '#9ca3af' }}
          title="Menu"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        {/* Center: ThinkDrop Logo */}
        <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none">
          <ThinkDropLogo size={22} />
        </div>

        {/* Right: Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Width Toggle */}
          <button
            onClick={onToggleWidth}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: '#9ca3af',
            }}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isExpanded ? (
                <>
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              ) : (
                <>
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              )}
            </svg>
          </button>

          {/* Copy Button */}
          {showCopyButton && (
            <button
              onClick={onCopy}
              className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors"
              style={{
                backgroundColor: isCopied ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: isCopied ? '#22c55e' : '#9ca3af',
              }}
              title={isCopied ? 'Copied!' : 'Copy response'}
            >
              {isCopied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              )}
            </button>
          )}

          {/* Close Button */}
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: '#9ca3af',
            }}
            title="Close (ESC)"
          >
            ×
          </button>
        </div>
      </div>

      {/* Row 2: TabBar */}
      <div style={{ flexShrink: 0 }}>
        <TabBar
          active={activeTab === 'settings' ? 'results' : activeTab as TabId}
          onSelect={(tab) => onTabSelect(tab as TabId | 'settings' | 'rules')}
          queueCount={queueCount}
          cronCount={cronCount}
          unreadTabs={unreadTabs}
        />
      </div>
    </div>
  );
}

export const OverlayHeader = React.memo(OverlayHeaderImpl);
export default OverlayHeader;
