import React, { useState, useCallback, useEffect } from 'react';
import { RightSlideoutDrawer } from './RightSlideoutDrawer';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface ParamSpec {
  name: string;
  type: string;
  description: string;
  required: boolean;
  example?: string;
}

interface WaypointPreview {
  step: number;
  type: string;
  selector?: string;
  altSelectors?: string[];
  value?: string;
  text?: string;
  paramRef?: string;
  originalValue?: string;
  elementText?: string;
  url?: string;
  href?: string;
  isParam?: boolean;
  key?: string;
  label?: string;
  checked?: boolean;
}

interface ReviewSkill {
  id: string;
  name: string;
  description: string;
  eventStart: number;
  eventEnd: number;
  waypoints?: WaypointPreview[];
  instructions?: string;
  execType?: string;
  params: ParamSpec[];
  startUrl?: string;
  targetUrl?: string;
}

interface ReviewRecipe {
  name: string;
  agentId?: string;
  skills: { skill: string }[];
  params: ParamSpec[];
  paramFlow: Record<string, string[]>;
}

interface TrainingReviewPanelProps {
  agentId: string;
  previewData: {
    skills: ReviewSkill[];
    recipe: ReviewRecipe | null;
    singleAction: boolean;
  };
  onSave: (adjustedData: { skills: ReviewSkill[]; recipe: ReviewRecipe | null }) => void;
  onCancel: () => void;
}

// ── Sortable skill card ──────────────────────────────────────────────────────
function SortableSkillCard({
  skill,
  index,
  onUpdateSkill,
  onToggleParam,
  onEditParam,
  onDeleteParam,
  onAddParam,
  onDeleteSkill,
}: {
  skill: ReviewSkill;
  index: number;
  onUpdateSkill: (id: string, updates: Partial<ReviewSkill>) => void;
  onToggleParam: (skillId: string, wpStep: number) => void;
  onEditParam: (skillId: string, paramName: string, updates: Partial<ParamSpec>) => void;
  onDeleteParam: (skillId: string, paramName: string) => void;
  onAddParam: (skillId: string) => void;
  onDeleteSkill: (skillId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: skill.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(skill.name);

  const handleNameSave = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && (trimmed.endsWith('.skill') || trimmed.endsWith('.recipe'))) {
      onUpdateSkill(skill.id, { name: trimmed });
    }
    setEditingName(false);
  };

  return (
    <div
      ref={setNodeRef}
      className="rounded-lg border border-white/10 overflow-hidden"
      style={{ ...style, background: 'rgba(255, 255, 255, 0.03)' }}
    >
      {/* Header with drag handle */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing min-w-0"
        style={{ background: 'rgba(255, 255, 255, 0.05)', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}
        {...attributes}
        {...listeners}
      >
        <span className="text-gray-500 text-xs">⋮⋮</span>
        <span className="text-[10px] text-gray-500 font-mono">SKILL {index + 1}</span>
        {editingName ? (
          <input
            type="text"
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={handleNameSave}
            onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setEditingName(false); }}
            autoFocus
            className="flex-1 min-w-0 px-2 py-1 rounded text-xs font-mono text-white outline-none"
            style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(16, 185, 129, 0.5)' }}
          />
        ) : (
          <span
            className="flex-1 min-w-0 text-xs font-mono text-emerald-400 cursor-text truncate"
            onClick={() => { setEditingName(true); setNameDraft(skill.name); }}
          >
            {skill.name}
          </span>
        )}
        <button
          onClick={() => onDeleteSkill(skill.id)}
          className="text-[10px] text-red-400/70 hover:text-red-400 px-1"
          title="Delete skill"
        >
          ✕
        </button>
      </div>

      {/* Description */}
      <div className="px-3 py-2 text-[11px] text-gray-400 italic">{skill.description}</div>

      {/* Instructions (agent-based skills) or Waypoints (legacy) */}
      {skill.execType === 'agent' || (skill.instructions && (skill.waypoints || []).length === 0) ? (
        <div className="px-3 pb-2 space-y-1">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Instructions</div>
          <textarea
            value={skill.instructions || ''}
            onChange={e => onUpdateSkill(skill.id, { instructions: e.target.value })}
            rows={6}
            className="w-full px-2 py-1.5 rounded text-[11px] font-mono text-gray-200 outline-none resize-y"
            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
            placeholder="Step-by-step instructions for the AI agent..."
          />
          <div className="text-[10px] text-gray-600">
            Use <code className="text-amber-400">{'{{param_name}}'}</code> placeholders for parameterized values.
            The agent will read the live DOM and find elements by intent.
          </div>
        </div>
      ) : (
        <div className="px-3 pb-2 space-y-1">
          {(skill.waypoints || []).map((wp, wi) => (
            <div key={wi} className="flex items-start gap-2 text-[11px] font-mono min-w-0">
              <span className="text-gray-600 w-6 text-right flex-shrink-0">{wp.step}.</span>
              <span className="text-blue-400 w-16 uppercase flex-shrink-0">{wp.type}</span>
              <span className="text-gray-300 flex-1 min-w-0 break-all">
                {wp.type === 'navigate' && (wp.url || '')}
                {wp.type === 'click' && (wp.elementText ? `"${wp.elementText}"` : wp.selector || '')}
                {wp.type === 'fill' && (
                  <span className="flex items-center gap-1 flex-wrap min-w-0">
                    <span className="text-gray-400">{wp.selector}</span>
                    <span className="text-gray-500">→</span>
                    {wp.paramRef ? (
                      <span className="text-amber-400 font-semibold">{`{{${wp.paramRef}}}`}</span>
                    ) : (
                      <span className="text-gray-300">"{(wp.value || '').substring(0, 40)}"</span>
                    )}
                    <button
                      onClick={() => onToggleParam(skill.id, wp.step)}
                      className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors"
                      style={{
                        background: wp.paramRef ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                        color: wp.paramRef ? '#f59e0b' : '#6b7280',
                        border: wp.paramRef ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid rgba(255, 255, 255, 0.1)',
                      }}
                    >
                      {wp.paramRef ? 'PARAM' : 'STATIC'}
                    </button>
                  </span>
                )}
                {wp.type === 'paste' && (
                  <span>
                    {wp.selector} → {wp.paramRef ? `{{${wp.paramRef}}}` : `"${(wp.text || '').substring(0, 40)}"`}
                  </span>
                )}
                {wp.type === 'select' && (
                  <span>
                    {wp.selector} → {wp.paramRef ? `{{${wp.paramRef}}}` : `"${wp.value || ''}"`}
                  </span>
                )}
                {wp.type === 'submit' && (wp.selector || '')}
                {wp.type === 'keycombo' && (wp.key || 'Enter')}
                {wp.type === 'check' && (wp.label || wp.selector || '')}
                {wp.type === 'hover' && (wp.selector || '')}
                {wp.type === 'dblclick' && (wp.elementText || wp.selector || '')}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Params section */}
      <div className="px-3 pb-3 pt-2" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Params</span>
          <button
            onClick={() => onAddParam(skill.id)}
            className="text-[10px] text-emerald-400/70 hover:text-emerald-400"
          >
            + Add param
          </button>
        </div>
        {(skill.params || []).length === 0 ? (
          <div className="text-[10px] text-gray-600 italic">No params (all static values)</div>
        ) : (
          <div className="space-y-1">
            {(skill.params || []).map((param, pi) => (
              <ParamRow
                key={pi}
                param={param}
                onEdit={(updates) => onEditParam(skill.id, param.name, updates)}
                onDelete={() => onDeleteParam(skill.id, param.name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Param row (inline editing) ───────────────────────────────────────────────
function ParamRow({
  param,
  onEdit,
  onDelete,
}: {
  param: ParamSpec;
  onEdit: (updates: Partial<ParamSpec>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(param);

  const handleSave = () => {
    onEdit({
      name: draft.name.trim() || param.name,
      description: draft.description.trim(),
      required: draft.required,
    });
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        className="flex items-center gap-2 text-[11px] cursor-pointer hover:bg-white/5 rounded px-2 py-1 min-w-0"
        onClick={() => { setEditing(true); setDraft(param); }}
      >
        <span className="font-mono text-amber-400 max-w-32 min-w-0 truncate">{param.name}</span>
        <span className="text-gray-400 flex-1 min-w-0 truncate">{param.description || '—'}</span>
        <span
          className="text-[9px] px-1.5 py-0.5 rounded font-bold flex-shrink-0"
          style={{
            background: param.required ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.05)',
            color: param.required ? '#ef4444' : '#6b7280',
          }}
        >
          {param.required ? 'REQUIRED' : 'OPTIONAL'}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-red-400/50 hover:text-red-400 text-[10px] flex-shrink-0"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 rounded" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
      <div className="flex gap-1 items-end">
        <div className="flex-1 min-w-0">
          <span className="text-[9px] text-gray-500 block mb-0.5">Name</span>
          <input
            type="text"
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            className="w-full px-2 py-1 rounded text-[11px] font-mono text-white outline-none"
            style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(245, 158, 11, 0.4)' }}
            placeholder="param_name (no spaces)"
          />
        </div>
        <label className="flex items-center gap-1 text-[10px] text-gray-400 pb-1">
          <input
            type="checkbox"
            checked={draft.required}
            onChange={e => setDraft({ ...draft, required: e.target.checked })}
          />
          req
        </label>
      </div>
      <div>
        <span className="text-[9px] text-gray-500 block mb-0.5">Description</span>
        <input
          type="text"
          value={draft.description}
          onChange={e => setDraft({ ...draft, description: e.target.value })}
          className="w-full px-2 py-1 rounded text-[11px] text-gray-300 outline-none"
          style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
          placeholder="What does this value represent?"
        />
      </div>
      <div className="flex gap-1">
        <button
          onClick={handleSave}
          className="px-2 py-0.5 rounded text-[10px] text-white"
          style={{ background: '#10b981' }}
        >
          Save
        </button>
        <button
          onClick={() => setEditing(false)}
          className="px-2 py-0.5 rounded text-[10px] text-gray-400"
          style={{ background: 'rgba(255, 255, 255, 0.05)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export function TrainingReviewPanel({ agentId, previewData, onSave, onCancel }: TrainingReviewPanelProps) {
  const [skills, setSkills] = useState<ReviewSkill[]>(previewData.skills || []);
  const [recipe, setRecipe] = useState<ReviewRecipe | null>(previewData.recipe || null);
  const [editingRecipeName, setEditingRecipeName] = useState(false);
  const [recipeNameDraft, setRecipeNameDraft] = useState(recipe?.name || '');
  const [isOpen, setIsOpen] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [previewResult, setPreviewResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showAddSkillDropdown, setShowAddSkillDropdown] = useState(false);
  const [existingSkills, setExistingSkills] = useState<any[]>([]);
  const [loadingExistingSkills, setLoadingExistingSkills] = useState(false);
  const ipcRenderer = (window as any).electron?.ipcRenderer;

  useEffect(() => {
    setIsOpen(true);
  }, []);

  // Update success message once the save completes (isSaving goes false)
  useEffect(() => {
    if (!isSaving && previewResult?.ok && previewResult.message !== 'Skill saved successfully. You can close this panel when ready.') {
      setPreviewResult({ ok: true, message: 'Skill saved successfully. You can close this panel when ready.' });
    }
  }, [isSaving, previewResult]);

  // Listen for preview-run results — auto-save on success with discovered keyPath
  useEffect(() => {
    if (!ipcRenderer) return;
    const handlePreviewRunResult = (data: any) => {
      if (data?.agentId !== agentId) return;
      setIsPreviewing(false);
      if (data.ok) {
        // Auto-save: inject the discovered keyPath into the first skill, then save
        const skillsWithKeyPath = skills.map((s, idx) =>
          idx === 0 && data.discoveredKeyPath ? { ...s, keyPath: data.discoveredKeyPath } : s
        );
        setSkills(skillsWithKeyPath);
        setPreviewResult({ ok: true, message: 'Training successful! Saving skill with discovered keyboard path…' });
        // Trigger save automatically
        let finalRecipe = recipe;
        if (recipe) {
          const allParams: ParamSpec[] = [];
          const paramFlow: Record<string, string[]> = {};
          const seenParams = new Set<string>();
          for (const skill of skillsWithKeyPath) {
            for (const param of (skill.params || [])) {
              if (!seenParams.has(param.name)) {
                seenParams.add(param.name);
                allParams.push(param);
              }
              if (!paramFlow[param.name]) paramFlow[param.name] = [];
              paramFlow[param.name].push(skill.name);
            }
          }
          finalRecipe = { ...recipe, skills: skillsWithKeyPath.map(s => ({ skill: s.name })), params: allParams, paramFlow };
        }
        setIsSaving(true);
        onSave({ skills: skillsWithKeyPath, recipe: finalRecipe });
      } else {
        setPreviewResult({ ok: false, message: data.error || 'Preview failed' });
      }
    };
    ipcRenderer.on('agents:train-preview-run-result', handlePreviewRunResult);
    return () => { ipcRenderer.removeListener('agents:train-preview-run-result', handlePreviewRunResult); };
  }, [agentId, ipcRenderer, skills, recipe, onSave]);

  // 10min safety timeout: first-run discovery can take several minutes as it
  // tabs through every element with LLM verification on each key press.
  // Subsequent runs use cached keyPath and are fast (~2.5s/step).
  useEffect(() => {
    if (!isPreviewing) return;
    const t = setTimeout(() => {
      setIsPreviewing(false);
      setPreviewResult({
        ok: false,
        message: 'Preview timed out after 10 minutes. The first run discovers the keyboard path by tabbing through every element with LLM verification — this can be slow. Try again, or check the logs for errors.',
      });
    }, 600000);
    return () => clearTimeout(t);
  }, [isPreviewing]);

  // Listen for trained-skills-list (response to agents:list-trained-skills)
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleTrainedSkillsList = (data: any) => {
      if (data?.agentId !== agentId) return;
      setLoadingExistingSkills(false);
      setExistingSkills(data.skills || []);
    };
    ipcRenderer.on('agents:trained-skills-list', handleTrainedSkillsList);
    return () => { ipcRenderer.removeListener('agents:trained-skills-list', handleTrainedSkillsList); };
  }, [agentId, ipcRenderer]);

  const handleAddExistingSkillClick = () => {
    if (showAddSkillDropdown) {
      setShowAddSkillDropdown(false);
      return;
    }
    setShowAddSkillDropdown(true);
    setLoadingExistingSkills(true);
    ipcRenderer?.send('agents:list-trained-skills', { agentId });
  };

  const handleAddExistingSkill = (skill: any) => {
    // Don't add if already in the list
    if (skills.some(s => s.name === skill.name)) return;
    const newSkill: ReviewSkill = {
      id: `existing_${skill.name}_${Date.now()}`,
      name: skill.name,
      description: skill.description || '',
      eventStart: 0,
      eventEnd: 0,
      waypoints: skill.waypoints || [],
      instructions: skill.instructions || '',
      execType: skill.execType || 'agent',
      params: skill.params || [],
      startUrl: skill.startUrl,
      targetUrl: skill.targetUrl,
    };
    setSkills(prev => [...prev, newSkill]);
    // Auto-create a recipe if none exists
    if (!recipe) {
      const baseName = skill.name.replace(/\.skill$/, '');
      setRecipe({
        name: `${baseName}.recipe`,
        skills: [...skills.map(s => ({ skill: s.name })), { skill: newSkill.name }],
        params: [],
        paramFlow: {},
      });
      setRecipeNameDraft(`${baseName}.recipe`);
    }
    setShowAddSkillDropdown(false);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSkills(items => {
        const oldIndex = items.findIndex(i => i.id === active.id);
        const newIndex = items.findIndex(i => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }, []);

  const updateSkill = (id: string, updates: Partial<ReviewSkill>) => {
    setSkills(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  };

  const toggleParam = (skillId: string, wpStep: number) => {
    setSkills(prev => prev.map(s => {
      if (s.id !== skillId) return s;
      const waypoints = (s.waypoints || []).map(wp => {
        if (wp.step !== wpStep) return wp;
        if (wp.paramRef) {
          // Toggle to static — restore original value
          return {
            ...wp,
            paramRef: undefined,
            value: wp.originalValue || wp.value?.replace(/^\{\{|\}\}$/g, '') || '',
            isParam: false,
          };
        } else {
          // Toggle to param — create a new param
          const paramName = `param_${wp.step}`;
          return {
            ...wp,
            paramRef: paramName,
            originalValue: wp.value,
            value: `{{${paramName}}}`,
            isParam: true,
          };
        }
      });
      // Update params array
      const wp = waypoints.find(w => w.step === wpStep);
      let params = [...(s.params || [])];
      if (wp?.paramRef) {
        if (!params.find(p => p.name === wp.paramRef)) {
          params.push({ name: wp.paramRef, type: 'string', description: wp.paramRef.replace(/_/g, ' '), required: true });
        }
      } else {
        const oldWp = (s.waypoints || []).find(w => w.step === wpStep);
        if (oldWp?.paramRef) {
          params = params.filter(p => p.name !== oldWp.paramRef);
        }
      }
      return { ...s, waypoints, params };
    }));
  };

  const editParam = (skillId: string, paramName: string, updates: Partial<ParamSpec>) => {
    // Sanitize param name to a valid identifier (no spaces, no special chars)
    if (updates.name) {
      updates.name = updates.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    }
    setSkills(prev => prev.map(s => {
      if (s.id !== skillId) return s;
      const params = (s.params || []).map(p => p.name === paramName ? { ...p, ...updates } : p);
      // If name changed, update paramRef in waypoints AND {{placeholder}} in instructions
      if (updates.name && updates.name !== paramName) {
        const waypoints = (s.waypoints || []).map(wp =>
          wp.paramRef === paramName ? { ...wp, paramRef: updates.name, value: `{{${updates.name}}}` } : wp
        );
        let instructions = s.instructions;
        if (instructions) {
          const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          instructions = instructions.replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'g'), `{{${updates.name}}}`);
        }
        return { ...s, params, waypoints, instructions };
      }
      return { ...s, params };
    }));
  };

  const deleteParam = (skillId: string, paramName: string) => {
    setSkills(prev => prev.map(s => {
      if (s.id !== skillId) return s;
      const params = (s.params || []).filter(p => p.name !== paramName);
      const waypoints = (s.waypoints || []).map(wp =>
        wp.paramRef === paramName
          ? { ...wp, paramRef: undefined, value: wp.originalValue || wp.value?.replace(/^\{\{|\}\}$/g, '') || '', isParam: false }
          : wp
      );
      return { ...s, params, waypoints };
    }));
  };

  const addParam = (skillId: string) => {
    setSkills(prev => prev.map(s => {
      if (s.id !== skillId) return s;
      const newParam: ParamSpec = {
        name: `param_${(s.params || []).length + 1}`,
        type: 'string',
        description: 'New parameter',
        required: true,
      };
      return { ...s, params: [...(s.params || []), newParam] };
    }));
  };

  const deleteSkill = (skillId: string) => {
    setSkills(prev => prev.filter(s => s.id !== skillId));
  };

  const addBoundary = () => {
    // Split the last skill at its midpoint
    if (skills.length === 0) return;
    const lastSkill = skills[skills.length - 1];
    const midPoint = Math.floor((lastSkill.waypoints || []).length / 2);
    if (midPoint < 1) return;
    const firstHalf = (lastSkill.waypoints || []).slice(0, midPoint);
    const secondHalf = (lastSkill.waypoints || []).slice(midPoint);
    const newSkill: ReviewSkill = {
      id: `skill_new_${Date.now()}`,
      name: `${lastSkill.name}.part2`,
      description: 'Split from ' + lastSkill.name,
      eventStart: lastSkill.eventStart + midPoint,
      eventEnd: lastSkill.eventEnd,
      waypoints: secondHalf,
      params: [],
      startUrl: lastSkill.startUrl,
      targetUrl: lastSkill.targetUrl,
    };
    updateSkill(lastSkill.id, {
      waypoints: firstHalf,
      eventEnd: lastSkill.eventStart + midPoint,
      name: `${lastSkill.name}.part1`,
    });
    setSkills(prev => [...prev, newSkill]);
  };

  const handleRecipeNameSave = () => {
    const trimmed = recipeNameDraft.trim();
    if (trimmed && recipe) {
      setRecipe({ ...recipe, name: trimmed });
    }
    setEditingRecipeName(false);
  };

  const handlePreviewRun = () => {
    // Instruction linting — warn about common issues before running
    const firstSkill = skills[0];
    if (firstSkill?.execType === 'agent' || firstSkill?.instructions) {
      const instr = firstSkill.instructions || '';
      const paramNames = (firstSkill.params || []).map(p => p.name);
      // Check: params defined but no placeholders in instructions
      const missingPlaceholders = paramNames.filter(name => !instr.includes(`{{${name}}}`));
      if (missingPlaceholders.length > 0) {
        setPreviewResult({
          ok: false,
          message: `Warning: Parameter(s) ${missingPlaceholders.map(n => `{{${n}}}`).join(', ')} are defined but not used in instructions. The agent will not know where to type them.`,
        });
      }
      // Check: duplicate action text (same click mentioned twice)
      const clickMatches = instr.match(/(?:Click|click)\s+["']?([^"'.]+)["']?/gi) || [];
      const clickTexts = clickMatches.map(m => m.toLowerCase().trim());
      const duplicates = clickTexts.filter((t, i) => clickTexts.indexOf(t) !== i);
      if (duplicates.length > 0) {
        setPreviewResult({
          ok: false,
          message: `Warning: Duplicate click detected: "${duplicates[0]}". This may cause the agent to perform the same action twice. Consider editing the instructions.`,
        });
      }
    }
    setIsPreviewing(true);
    setPreviewResult(null);
    // Build the same finalRecipe structure as handleSave
    let finalRecipe = recipe;
    if (recipe) {
      const allParams: ParamSpec[] = [];
      const paramFlow: Record<string, string[]> = {};
      const seenParams = new Set<string>();
      for (const skill of skills) {
        for (const param of (skill.params || [])) {
          if (!seenParams.has(param.name)) {
            seenParams.add(param.name);
            allParams.push(param);
          }
          if (!paramFlow[param.name]) paramFlow[param.name] = [];
          paramFlow[param.name].push(skill.name);
        }
      }
      finalRecipe = { ...recipe, skills: skills.map(s => ({ skill: s.name })), params: allParams, paramFlow };
    }
    ipcRenderer?.send('agents:train-preview-run', {
      agentId,
      skills,
      recipe: finalRecipe,
    });
  };

  return (
    <RightSlideoutDrawer
      isOpen={isOpen}
      onClose={onCancel}
      width={520}
      zIndex={60}
      title="Review Trained Skills"
      subtitle={`${skills.length} skill(s)${recipe ? ' + 1 recipe' : ''} • Adjust boundaries, params, and names`}
    >
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={skills.map(s => s.id)} strategy={verticalListSortingStrategy}>
            {skills.map((skill, i) => (
              <React.Fragment key={skill.id}>
                <SortableSkillCard
                  skill={skill}
                  index={i}
                  onUpdateSkill={updateSkill}
                  onToggleParam={toggleParam}
                  onEditParam={editParam}
                  onDeleteParam={deleteParam}
                  onAddParam={addParam}
                  onDeleteSkill={deleteSkill}
                />
                {i < skills.length - 1 && (
                  <div className="flex items-center gap-2 py-1 px-2">
                    <div className="flex-1 border-t border-dashed" style={{ borderColor: 'rgba(255, 255, 255, 0.15)' }} />
                    <span className="text-[9px] text-gray-600 uppercase">boundary</span>
                    <div className="flex-1 border-t border-dashed" style={{ borderColor: 'rgba(255, 255, 255, 0.15)' }} />
                  </div>
                )}
              </React.Fragment>
            ))}
          </SortableContext>
        </DndContext>

        {/* Add boundary button */}
        {skills.length > 0 && (
          <button
            onClick={addBoundary}
            className="w-full py-2 rounded-lg text-[11px] text-gray-400 hover:text-white transition-colors"
            style={{ border: '1px dashed rgba(255, 255, 255, 0.15)', background: 'transparent' }}
          >
            + Add boundary (split last skill)
          </button>
        )}

        {/* Add existing skill button + dropdown */}
        <div className="relative">
          <button
            onClick={handleAddExistingSkillClick}
            className="w-full py-2 rounded-lg text-[11px] text-emerald-400/80 hover:text-emerald-400 transition-colors"
            style={{ border: '1px dashed rgba(16, 185, 129, 0.25)', background: 'rgba(16, 185, 129, 0.03)' }}
          >
            + Add existing skill to recipe chain
          </button>
          {showAddSkillDropdown && (
            <div
              className="absolute left-0 right-0 mt-1 rounded-lg border max-h-64 overflow-y-auto"
              style={{
                background: 'rgba(28, 28, 30, 0.99)',
                borderColor: 'rgba(255, 255, 255, 0.15)',
                zIndex: 100,
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              }}
            >
              {loadingExistingSkills ? (
                <div className="px-3 py-3 text-[11px] text-gray-500 italic">Loading trained skills…</div>
              ) : existingSkills.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-gray-500 italic">No trained skills found for this agent yet.</div>
              ) : (
                existingSkills.map((skill, i) => {
                  const alreadyAdded = skills.some(s => s.name === skill.name);
                  return (
                    <button
                      key={i}
                      onClick={() => !alreadyAdded && handleAddExistingSkill(skill)}
                      disabled={alreadyAdded}
                      className="w-full text-left px-3 py-2 text-[11px] hover:bg-white/5 transition-colors"
                      style={{
                        color: alreadyAdded ? '#4b5563' : '#d1d5db',
                        cursor: alreadyAdded ? 'not-allowed' : 'pointer',
                        borderBottom: i < existingSkills.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[9px] px-1 py-0.5 rounded font-bold flex-shrink-0"
                          style={{
                            background: skill.isRecipe ? 'rgba(16, 185, 129, 0.15)' : 'rgba(99, 102, 241, 0.15)',
                            color: skill.isRecipe ? '#34d399' : '#818cf8',
                          }}
                        >
                          {skill.isRecipe ? 'RECIPE' : 'SKILL'}
                        </span>
                        <span className="font-mono truncate flex-1 min-w-0">{skill.name}</span>
                        {alreadyAdded && <span className="text-[9px] text-gray-600 flex-shrink-0">added</span>}
                      </div>
                      {skill.description && (
                        <div className="text-[10px] text-gray-500 mt-0.5 truncate">{skill.description}</div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Recipe section */}
        {recipe && (
          <div
            className="rounded-lg border p-3"
            style={{ borderColor: 'rgba(16, 185, 129, 0.3)', background: 'rgba(16, 185, 129, 0.05)' }}
          >
            <div className="flex items-center gap-2 mb-2 min-w-0">
              <span className="text-[10px] text-emerald-500/70 font-mono flex-shrink-0">RECIPE</span>
              {editingRecipeName ? (
                <input
                  type="text"
                  value={recipeNameDraft}
                  onChange={e => setRecipeNameDraft(e.target.value)}
                  onBlur={handleRecipeNameSave}
                  onKeyDown={e => { if (e.key === 'Enter') handleRecipeNameSave(); if (e.key === 'Escape') setEditingRecipeName(false); }}
                  autoFocus
                  className="flex-1 min-w-0 px-2 py-1 rounded text-xs font-mono text-white outline-none"
                  style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(16, 185, 129, 0.5)' }}
                />
              ) : (
                <span
                  className="flex-1 min-w-0 text-xs font-mono text-emerald-400 cursor-text truncate"
                  onClick={() => { setEditingRecipeName(true); setRecipeNameDraft(recipe.name); }}
                >
                  {recipe.name}
                </span>
              )}
            </div>

            {/* Skill chain */}
            <div className="flex flex-wrap items-center gap-1 mb-2">
              {skills.map((s, i) => (
                <React.Fragment key={s.id}>
                  <span className="text-[10px] font-mono text-emerald-300 px-1.5 py-0.5 rounded" style={{ background: 'rgba(16, 185, 129, 0.1)' }}>
                    {s.name}
                  </span>
                  {i < skills.length - 1 && <span className="text-gray-500 text-[10px]">→</span>}
                </React.Fragment>
              ))}
            </div>

            {/* Param flow */}
            {Object.keys(recipe.paramFlow || {}).length > 0 && (
              <div className="space-y-0.5">
                <div className="text-[9px] text-gray-500 uppercase mb-1">Param Flow</div>
                {Object.entries(recipe.paramFlow).map(([param, skillNames]) => (
                  <div key={param} className="flex items-center gap-1 text-[10px]">
                    <span className="font-mono text-amber-400">{param}</span>
                    <span className="text-gray-500">→</span>
                    <span className="text-gray-400">{skillNames.join(', ')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Preview status banner */}
      {previewResult && (
        <div
          className="mx-4 mb-2 px-3 py-2 rounded-lg text-xs"
          style={{
            background: previewResult.ok ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            border: `1px solid ${previewResult.ok ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            color: previewResult.ok ? '#6ee7b7' : '#fca5a5',
          }}
        >
          {previewResult.message}
        </div>
      )}

      {/* Footer with Train & Save + cancel buttons */}
      <div className="px-4 py-3 flex items-stretch gap-2" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <button
          onClick={handlePreviewRun}
          disabled={skills.length === 0 || isPreviewing || isSaving}
          className="flex-1 min-h-[42px] rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-2 transition-opacity"
          style={{
            background: skills.length === 0 || isPreviewing || isSaving ? 'rgba(16, 185, 129, 0.15)' : '#10b981',
            opacity: skills.length === 0 || isPreviewing || isSaving ? 0.4 : 1,
            cursor: skills.length === 0 || isPreviewing || isSaving ? 'not-allowed' : 'pointer',
          }}
          title="Runs the skill to discover the keyboard path (slow first run), then saves automatically."
        >
          {isPreviewing ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span>Discovering path…</span>
            </>
          ) : isSaving ? (
            'Saving…'
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <span>Train & Save{recipe ? ' & Recipe' : ''}</span>
            </>
          )}
        </button>
        <button
          onClick={onCancel}
          disabled={isPreviewing}
          className="px-4 min-h-[42px] rounded-lg text-sm text-gray-400 flex items-center justify-center"
          style={{ border: '1px solid rgba(255, 255, 255, 0.1)', background: 'transparent', opacity: isPreviewing ? 0.4 : 1 }}
        >
          {!isPreviewing && !isSaving && previewResult?.ok ? 'Close' : 'Cancel'}
        </button>
      </div>
      {/* Info note about first-run discovery */}
      {isPreviewing && (
        <div className="px-4 pb-2 text-[10px] text-gray-500 leading-tight">
          First run discovers the keyboard path (Tab/Arrow/Enter) with LLM verification on each key press — this can take several minutes.
          Subsequent runs use the cached path and are fast (~2.5s per step).
        </div>
      )}
    </RightSlideoutDrawer>
  );
}
