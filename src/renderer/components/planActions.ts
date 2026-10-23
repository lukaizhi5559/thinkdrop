/**
 * planActions.ts — shared plan card action handlers for the Results feed.
 *
 * The Plans tab keeps its own notice/refresh-coupled handlers; these are the
 * standalone IPC calls the feed strip and plan-card feed entries use, with
 * failures surfaced as feed system entries by the caller.
 */

import type { PlanSummary } from './PlanCard';

const ipcRenderer = (window as any).electron?.ipcRenderer;

/** Pin planning mode for this plan — the prompt lane binds to the thread. */
export function continuePlan(p: PlanSummary): void {
  ipcRenderer?.send('planning:set', {
    active: true, planId: p.planId, planName: p.name, planFile: p.file,
  });
}

export async function runPlan(p: PlanSummary): Promise<{ ok?: boolean; error?: string; blockers?: any[] }> {
  if (!ipcRenderer) return { error: 'ipc unavailable' };
  return ipcRenderer.invoke('plan:run', { planFile: p.file }).catch((e: any) => ({ error: e?.message || String(e) }));
}

export async function cancelPlanRun(p: PlanSummary): Promise<{ ok?: boolean; error?: string }> {
  if (!ipcRenderer) return { error: 'ipc unavailable' };
  return ipcRenderer.invoke('plan:run-cancel', { planId: p.planId }).catch((e: any) => ({ error: e?.message || String(e) }));
}

export async function deletePlan(p: PlanSummary): Promise<{ ok?: boolean; error?: string }> {
  if (!ipcRenderer) return { error: 'ipc unavailable' };
  return ipcRenderer.invoke('plan:delete', { planFile: p.file }).catch((e: any) => ({ error: e?.message || String(e) }));
}
