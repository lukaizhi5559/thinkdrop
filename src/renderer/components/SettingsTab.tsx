import { useState, useEffect } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface ShortcutItem {
  key: string;
  description: string;
}

export function SettingsTab() {
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>([
    { key: 'Cmd+Shift+T', description: 'Toggle overlay' },
    { key: 'Esc', description: 'Hide overlay' },
    { key: 'Enter', description: 'Submit prompt' },
    { key: 'Shift+Enter', description: 'New line in prompt' },
  ]);

  useEffect(() => {
    // Request shortcuts from main process
    ipcRenderer?.send('settings:get-shortcuts');

    const handleShortcuts = (_e: any, data: { shortcuts: ShortcutItem[] }) => {
      if (data.shortcuts) {
        setShortcuts(data.shortcuts);
      }
    };

    ipcRenderer?.on('settings:shortcuts', handleShortcuts);

    return () => {
      ipcRenderer?.removeListener('settings:shortcuts', handleShortcuts);
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Keyboard Shortcuts</h3>
        <div className="space-y-2">
          {shortcuts.map((shortcut, index) => (
            <div
              key={index}
              className="flex items-center justify-between p-3 rounded-lg"
              style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}
            >
              <span className="text-sm text-gray-400">{shortcut.description}</span>
              <kbd
                className="px-2 py-1 rounded text-xs font-mono"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  color: '#9ca3af',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                }}
              >
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">About</h3>
        <p className="text-xs text-gray-500">
          ThinkDrop Unified Overlay
        </p>
      </div>
    </div>
  );
}
