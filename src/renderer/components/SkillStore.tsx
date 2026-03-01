import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import skillLibraryData from '../data/skill-library.json';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface SkillEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  ocUrl: string;
  rawUrl: string;
}
interface SkillLibrary {
  generatedAt: string;
  totalSkills: number;
  categories: string[];
  skills: SkillEntry[];
}
export interface SkillBuildRequest { skill: SkillEntry; }
interface SkillStoreProps {
  onBuildSkill?: (req: SkillBuildRequest) => void;
  initialSearch?: string;
}

const library = skillLibraryData as SkillLibrary;
const ITEMS_PER_PAGE = 30;

const CAT_COLORS: Record<string, string> = {
  'Browser & Automation': '#3b82f6',
  'Coding Agents & IDEs': '#8b5cf6',
  'DevOps & Cloud': '#06b6d4',
  'AI & LLMs': '#a78bfa',
  'Web & Frontend Development': '#f59e0b',
  'Git & GitHub': '#f97316',
  'Search & Research': '#10b981',
  'Communication': '#ec4899',
  'Productivity & Tasks': '#6366f1',
  'Data & Analytics': '#14b8a6',
  'CLI Utilities': '#84cc16',
  'PDF & Documents': '#fb923c',
  'Image & Video Generation': '#e879f9',
  'Media & Streaming': '#f43f5e',
  'Health & Fitness': '#22c55e',
};
const catColor = (c: string) => CAT_COLORS[c] || '#6b7280';

function HiMatch({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return <>{text}</>;
  return <>
    {text.slice(0, i)}
    <mark style={{ background: 'rgba(139,92,246,0.38)', color: '#ddd6fe', borderRadius: 2, padding: '0 1px' }}>
      {text.slice(i, i + q.length)}
    </mark>
    {text.slice(i + q.length)}
  </>;
}

export default function SkillStore({ onBuildSkill, initialSearch = '' }: SkillStoreProps) {
  const [search, setSearch] = useState(initialSearch);
  const [cat, setCat] = useState('All');
  const [page, setPage] = useState(1);
  const [building, setBuilding] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (initialSearch) setSearch(initialSearch); }, [initialSearch]);
  useEffect(() => { setPage(1); }, [search, cat]);

  useEffect(() => {
    if (!ipcRenderer) return;
    const onDone = (_e: any, { name, ok }: { name: string; ok: boolean }) => {
      if (ok && building === name) setBuilding(null);
    };
    ipcRenderer.on('skill:build-done', onDone);
    return () => { ipcRenderer.removeListener?.('skill:build-done', onDone); };
  }, [building]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return library.skills.filter(s => {
      if (cat !== 'All' && s.category !== cat) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [search, cat]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const shown = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
  const cats = useMemo(() => ['All', ...library.categories], []);

  const handleBuild = useCallback((skill: SkillEntry) => {
    setBuilding(skill.name);
    onBuildSkill?.({ skill });
    ipcRenderer?.send('skill:build-start', skill);
  }, [onBuildSkill]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>

      {/* ── Search ── */}
      <div style={{ position: 'relative' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input ref={inputRef} type="text"
          placeholder={`Search ${library.totalSkills.toLocaleString()} skills…`}
          value={search} onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '5px 26px 5px 26px',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 7, color: '#e5e7eb', fontSize: '0.74rem', outline: 'none',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = 'rgba(139,92,246,0.5)'; }}
          onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; }}
        />
        {search && (
          <button onClick={() => setSearch('')}
            style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '0.7rem', padding: 2 }}>
            ✕
          </button>
        )}
      </div>

      {/* ── Category pills — single scrollable row ── */}
      <div className="hide-scrollbar" style={{
        display: 'flex', gap: 3, flexWrap: 'nowrap',
        overflowX: 'auto', paddingBottom: 2,
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      }}>
        {cats.map(c => {
          const active = cat === c;
          const col = c === 'All' ? '#8b5cf6' : catColor(c);
          return (
            <button key={c} onClick={() => setCat(c)} style={{
              padding: '2px 7px', borderRadius: 20, fontSize: '0.63rem', fontWeight: 500,
              cursor: 'pointer', border: `1px solid ${active ? col : 'rgba(255,255,255,0.08)'}`,
              background: active ? `${col}22` : 'transparent',
              color: active ? col : '#6b7280', transition: 'all 0.1s',
              flexShrink: 0, whiteSpace: 'nowrap',
            }}>
              {c}
            </button>
          );
        })}
      </div>

      {/* ── Result count ── */}
      <div style={{ color: '#4b5563', fontSize: '0.64rem' }}>
        {filtered.length === 0 ? 'No skills match' :
          `${filtered.length.toLocaleString()} skill${filtered.length !== 1 ? 's' : ''}${search ? ` for "${search}"` : ''} · page ${page} / ${totalPages}`}
      </div>

      {/* ── Skill cards ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 380, overflowY: 'auto',
        scrollbarWidth: 'thin', scrollbarColor: 'rgba(139,92,246,0.3) transparent' }}>
        {shown.length === 0 ? (
          <div style={{ color: '#4b5563', fontSize: '0.72rem', padding: '10px 0', textAlign: 'center' }}>
            No skills found. Try a different search or category.
          </div>
        ) : shown.map(skill => {
          const col = catColor(skill.category);
          const isBuilding = building === skill.name;
          return (
            <div key={skill.name} style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 9px',
              borderRadius: 8, transition: 'all 0.12s',
              background: isBuilding ? `${col}14` : 'rgba(255,255,255,0.025)',
              border: `1px solid ${isBuilding ? `${col}44` : 'rgba(255,255,255,0.06)'}`,
            }}>
              {/* Category dot */}
              <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 4,
                background: col, boxShadow: `0 0 5px ${col}55` }} />

              {/* Text */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
                  <span style={{ color: '#c4b5fd', fontSize: '0.73rem', fontWeight: 600,
                    fontFamily: 'ui-monospace,monospace' }}>
                    <HiMatch text={skill.displayName} q={search} />
                  </span>
                  <span style={{ fontSize: '0.6rem', padding: '1px 6px', borderRadius: 10,
                    background: `${col}18`, color: col, border: `1px solid ${col}33`, flexShrink: 0 }}>
                    {skill.category}
                  </span>
                </div>
                <div style={{ color: '#9ca3af', fontSize: '0.68rem', lineHeight: 1.4 }}>
                  <HiMatch text={skill.description} q={search} />
                </div>
              </div>

              {/* Build button */}
              <button onClick={() => !isBuilding && handleBuild(skill)}
                disabled={!!building}
                title={isBuilding ? 'Building…' : `Build "${skill.displayName}" for ThinkDrop`}
                style={{
                  flexShrink: 0, padding: '4px 9px', borderRadius: 6, fontSize: '0.67rem',
                  fontWeight: 600, cursor: building ? 'not-allowed' : 'pointer',
                  border: `1px solid ${isBuilding ? `${col}55` : 'rgba(139,92,246,0.45)'}`,
                  background: isBuilding ? `${col}22` : 'rgba(139,92,246,0.15)',
                  color: isBuilding ? col : '#c4b5fd',
                  opacity: building && !isBuilding ? 0.35 : 1,
                  transition: 'all 0.12s', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                {isBuilding ? (
                  <>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
                        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/>
                      </path>
                    </svg>
                    Building…
                  </>
                ) : (
                  <>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                    Build
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
            style={{ padding: '2px 8px', borderRadius: 5, fontSize: '0.68rem', cursor: page === 1 ? 'not-allowed' : 'pointer',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              color: page === 1 ? '#374151' : '#9ca3af' }}>
            ‹ Prev
          </button>
          <span style={{ color: '#6b7280', fontSize: '0.66rem' }}>{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
            style={{ padding: '2px 8px', borderRadius: 5, fontSize: '0.68rem', cursor: page === totalPages ? 'not-allowed' : 'pointer',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              color: page === totalPages ? '#374151' : '#9ca3af' }}>
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
