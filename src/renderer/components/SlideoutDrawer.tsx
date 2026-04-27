import { type TabId } from './TabComponents';

interface SlideoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (tab: TabId | 'settings') => void;
  activeTab: TabId | 'settings';
}

type MenuItem =
  | { type: 'item'; id: TabId | 'settings'; label: string; icon: string }
  | { type: 'divider' };

export function SlideoutDrawer({ isOpen, onClose, onNavigate, activeTab }: SlideoutDrawerProps) {
  const menuItems: MenuItem[] = [
    { type: 'item', id: 'settings', label: 'Settings', icon: '⚙️' },
    { type: 'divider' },
    { type: 'item', id: 'skills', label: 'Skills', icon: '📦' },
    { type: 'item', id: 'connections', label: 'Connections', icon: '🔌' },
    { type: 'item', id: 'store', label: 'Store', icon: '🛒' },
  ];

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          style={{ top: '48px' }} // Below header
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        className="fixed left-0 top-[48px] bottom-0 w-[280px] z-50 transition-transform duration-300 ease-out"
        style={{
          backgroundColor: 'rgba(28, 28, 30, 0.98)',
          borderRight: '1px solid rgba(255, 255, 255, 0.1)',
          transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}
        >
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors"
            style={{ color: '#9ca3af' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="text-sm font-medium text-gray-300">ThinkDrop</span>
        </div>

        {/* Menu Items */}
        <div className="p-2">
          {menuItems.map((item, index) => {
            if (item.type === 'divider') {
              return (
                <div
                  key={`divider-${index}`}
                  className="my-2 border-t"
                  style={{ borderColor: 'rgba(255, 255, 255, 0.1)' }}
                />
              );
            }

            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors"
                style={{
                  backgroundColor: isActive ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  color: isActive ? '#93c5fd' : '#d1d5db',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <span className="text-lg">{item.icon}</span>
                <span className="text-sm font-medium">{item.label}</span>
                {isActive && (
                  <svg
                    className="ml-auto"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
