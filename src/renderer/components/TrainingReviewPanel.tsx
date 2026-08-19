import React, { useState, useCallback } from 'react';
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
  waypoints: WaypointPreview[];
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
        className="flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing"
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
            className="flex-1 px-2 py-1 rounded text-xs font-mono text-white outline-none"
            style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(16, 185, 129, 0.5)' }}
          />
        ) : (
          <span
            className="flex-1 text-xs font-mono text-emerald-400 cursor-text"
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

      {/* Waypoints */}
      <div className="px-3 pb-2 space-y-1">
        {skill.waypoints.map((wp, wi) => (
          <div key={wi} className="flex items-start gap-2 text-[11px] font-mono">
            <span className="text-gray-600 w-6 text-right">{wp.step}.</span>
            <span className="text-blue-400 w-16 uppercase">{wp.type}</span>
            <span className="text-gray-300 flex-1 break-all">
              {wp.type === 'navigate' && (wp.url || '')}
              {wp.type === 'click' && (wp.elementText ? `"${wp.elementText}"` : wp.selector || '')}
              {wp.type === 'fill' && (
                <span className="flex items-center gap-1 flex-wrap">
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
        {skill.params.length === 0 ? (
          <div className="text-[10px] text-gray-600 italic">No params (all static values)</div>
        ) : (
          <div className="space-y-1">
            {skill.params.map((param, pi) => (
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
        className="flex items-center gap-2 text-[11px] cursor-pointer hover:bg-white/5 rounded px-2 py-1"
        onClick={() => { setEditing(true); setDraft(param); }}
      >
        <span className="font-mono text-amber-400 w-32 truncate">{param.name}</span>
        <span className="text-gray-400 flex-1 truncate">{param.description || '—'}</span>
        <span
          className="text-[9px] px-1.5 py-0.5 rounded font-bold"
          style={{
            background: param.required ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.05)',
            color: param.required ? '#ef4444' : '#6b7280',
          }}
        >
          {param.required ? 'REQUIRED' : 'OPTIONAL'}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-red-400/50 hover:text-red-400 text-[10px]"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 rounded" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
      <div className="flex gap-1">
        <input
          type="text"
          value={draft.name}
          onChange={e => setDraft({ ...draft, name: e.target.value })}
          className="flex-1 px-2 py-1 rounded text-[11px] font-mono text-white outline-none"
          style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(245, 158, 11, 0.4)' }}
          placeholder="param_name"
        />
        <label className="flex items-center gap-1 text-[10px] text-gray-400">
          <input
            type="checkbox"
            checked={draft.required}
            onChange={e => setDraft({ ...draft, required: e.target.checked })}
          />
          req
        </label>
      </div>
      <input
        type="text"
        value={draft.description}
        onChange={e => setDraft({ ...draft, description: e.target.value })}
        className="px-2 py-1 rounded text-[11px] text-gray-300 outline-none"
        style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
        placeholder="Description"
      />
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
export function TrainingReviewPanel({ agentId: _agentId, previewData, onSave, onCancel }: TrainingReviewPanelProps) {
  const [skills, setSkills] = useState<ReviewSkill[]>(previewData.skills || []);
  const [recipe, setRecipe] = useState<ReviewRecipe | null>(previewData.recipe || null);
  const [editingRecipeName, setEditingRecipeName] = useState(false);
  const [recipeNameDraft, setRecipeNameDraft] = useState(recipe?.name || '');

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
      const waypoints = s.waypoints.map(wp => {
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
      let params = [...s.params];
      if (wp?.paramRef) {
        if (!params.find(p => p.name === wp.paramRef)) {
          params.push({ name: wp.paramRef, type: 'string', description: wp.paramRef.replace(/_/g, ' '), required: true });
        }
      } else {
        const oldWp = s.waypoints.find(w => w.step === wpStep);
        if (oldWp?.paramRef) {
          params = params.filter(p => p.name !== oldWp.paramRef);
        }
      }
      return { ...s, waypoints, params };
    }));
  };

  const editParam = (skillId: string, paramName: string, updates: Partial<ParamSpec>) => {
    setSkills(prev => prev.map(s => {
      if (s.id !== skillId) return s;
      const params = s.params.map(p => p.name === paramName ? { ...p, ...updates } : p);
      // If name changed, update paramRef in waypoints too
      if (updates.name && updates.name !== paramName) {
        const waypoints = s.waypoints.map(wp =>
          wp.paramRef === paramName ? { ...wp, paramRef: updates.name, value: `{{${updates.name}}}` } : wp
        );
        return { ...s, params, waypoints };
      }
      return { ...s, params };
    }));
  };

  const deleteParam = (skillId: string, paramName: string) => {
    setSkills(prev => prev.map(s => {
      if (s.id !== skillId) return s;
      const params = s.params.filter(p => p.name !== paramName);
      const waypoints = s.waypoints.map(wp =>
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
        name: `param_${s.params.length + 1}`,
        type: 'string',
        description: 'New parameter',
        required: true,
      };
      return { ...s, params: [...s.params, newParam] };
    }));
  };

  const deleteSkill = (skillId: string) => {
    setSkills(prev => prev.filter(s => s.id !== skillId));
  };

  const addBoundary = () => {
    // Split the last skill at its midpoint
    if (skills.length === 0) return;
    const lastSkill = skills[skills.length - 1];
    const midPoint = Math.floor(lastSkill.waypoints.length / 2);
    if (midPoint < 1) return;
    const firstHalf = lastSkill.waypoints.slice(0, midPoint);
    const secondHalf = lastSkill.waypoints.slice(midPoint);
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

  const handleSave = () => {
    // Recompute recipe paramFlow if recipe exists
    let finalRecipe = recipe;
    if (recipe) {
      const allParams: ParamSpec[] = [];
      const paramFlow: Record<string, string[]> = {};
      const seenParams = new Set<string>();
      for (const skill of skills) {
        for (const param of skill.params) {
          if (!seenParams.has(param.name)) {
            seenParams.add(param.name);
            allParams.push(param);
          }
          if (!paramFlow[param.name]) paramFlow[param.name] = [];
          paramFlow[param.name].push(skill.name);
        }
      }
      finalRecipe = {
        ...recipe,
        skills: skills.map(s => ({ skill: s.name })),
        params: allParams,
        paramFlow,
      };
    }
    onSave({ skills, recipe: finalRecipe });
  };

  const handleRecipeNameSave = () => {
    const trimmed = recipeNameDraft.trim();
    if (trimmed && recipe) {
      setRecipe({ ...recipe, name: trimmed });
    }
    setEditingRecipeName(false);
  };

  return (
    <div
      className="fixed top-0 right-0 h-full flex flex-col"
      style={{
        width: '480px',
        background: 'rgba(28, 28, 30, 0.98)',
        borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
        zIndex: 1000,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <div>
          <h2 className="text-sm font-semibold text-white">Review Trained Skills</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">
            {skills.length} skill(s){recipe ? ` + 1 recipe` : ''} • Adjust boundaries, params, and names
          </p>
        </div>
        <button
          onClick={onCancel}
          className="text-gray-400 hover:text-white text-sm px-2 py-1"
        >
          Cancel
        </button>
      </div>

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

        {/* Recipe section */}
        {recipe && (
          <div
            className="rounded-lg border p-3"
            style={{ borderColor: 'rgba(16, 185, 129, 0.3)', background: 'rgba(16, 185, 129, 0.05)' }}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] text-emerald-500/70 font-mono">RECIPE</span>
              {editingRecipeName ? (
                <input
                  type="text"
                  value={recipeNameDraft}
                  onChange={e => setRecipeNameDraft(e.target.value)}
                  onBlur={handleRecipeNameSave}
                  onKeyDown={e => { if (e.key === 'Enter') handleRecipeNameSave(); if (e.key === 'Escape') setEditingRecipeName(false); }}
                  autoFocus
                  className="flex-1 px-2 py-1 rounded text-xs font-mono text-white outline-none"
                  style={{ background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(16, 185, 129, 0.5)' }}
                />
              ) : (
                <span
                  className="flex-1 text-xs font-mono text-emerald-400 cursor-text"
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

      {/* Footer with save button */}
      <div className="px-4 py-3 flex gap-2" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <button
          onClick={handleSave}
          disabled={skills.length === 0}
          className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity"
          style={{
            background: skills.length === 0 ? 'rgba(16, 185, 129, 0.15)' : '#10b981',
            opacity: skills.length === 0 ? 0.4 : 1,
            cursor: skills.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          Save All Skills{recipe ? ' & Recipe' : ''}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 rounded-lg text-sm text-gray-400"
          style={{ border: '1px solid rgba(255, 255, 255, 0.1)', background: 'transparent' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
