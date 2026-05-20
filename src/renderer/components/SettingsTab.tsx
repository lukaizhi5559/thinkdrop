import { useState, useEffect } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface ShortcutItem {
  key: string;
  description: string;
}

type PlanApprovalMode = 'always' | 'multi_step' | 'auto';

const PLAN_APPROVAL_OPTIONS: { value: PlanApprovalMode; label: string; desc: string }[] = [
  { value: 'always',     label: 'Always approve',       desc: 'Every plan pauses for your review' },
  { value: 'multi_step', label: 'Multi-step plans only', desc: '2+ step plans pause; single-step auto-runs' },
  { value: 'auto',       label: 'Auto-approve all',     desc: 'Plans execute immediately without review' },
];

export function SettingsTab() {
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>([
    { key: 'Cmd+Shift+T', description: 'Toggle overlay' },
    { key: 'Esc', description: 'Hide overlay' },
    { key: 'Enter', description: 'Submit prompt' },
    { key: 'Shift+Enter', description: 'New line in prompt' },
  ]);

  const [planApproval, setPlanApproval] = useState<PlanApprovalMode>('multi_step');

  useEffect(() => {
    // Request shortcuts from main process
    ipcRenderer?.send('settings:get-shortcuts');

    const handleShortcuts = (_e: any, data: { shortcuts: ShortcutItem[] }) => {
      if (data.shortcuts) {
        setShortcuts(data.shortcuts);
      }
    };

    ipcRenderer?.on('settings:shortcuts', handleShortcuts);

    // Load plan approval setting
    ipcRenderer?.invoke('settings:get', { key: 'planApprovalMode' }).then((res: any) => {
      if (res?.value && ['always', 'multi_step', 'auto'].includes(res.value)) {
        setPlanApproval(res.value);
      }
    });

    return () => {
      ipcRenderer?.removeListener('settings:shortcuts', handleShortcuts);
    };
  }, []);

  const handlePlanApprovalChange = (mode: PlanApprovalMode) => {
    setPlanApproval(mode);
    ipcRenderer?.send('settings:set', { key: 'planApprovalMode', value: mode });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Plan Approval</h3>
        <p className="text-xs text-gray-500 mb-3">
          Control when plans require your approval before running.
        </p>
        <div className="space-y-2">
          {PLAN_APPROVAL_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors"
              style={{
                backgroundColor: planApproval === opt.value ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                border: planApproval === opt.value ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid transparent',
              }}
            >
              <input
                type="radio"
                name="planApproval"
                value={opt.value}
                checked={planApproval === opt.value}
                onChange={() => handlePlanApprovalChange(opt.value)}
                className="mt-0.5"
                style={{ accentColor: '#3b82f6' }}
              />
              <div>
                <span className="text-sm text-gray-300 font-medium">{opt.label}</span>
                <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

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
