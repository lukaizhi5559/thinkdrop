'use strict';

/**
 * service-registry.cjs — single source of truth for ThinkDrop's local services.
 *
 * Read by: scripts/service-gate.mjs (coldable set), src/main/serviceManager.js
 * (health/control), the Services panel via services:list IPC.
 *
 * tier:
 *   warm      — always running; restart allowed, off/on via spawn/kill
 *   protected — guardian path (user-memory, phi4); off requires confirm in UI
 *   coldable  — owned by service-gate in --gate mode; warm/auto/off modes
 *   external  — not ours to spawn (ollama, thinkdrop-backend); health only
 *
 * Fields: id, label, port, healthPath, logFile, tier, dir/entry/cmd/heap
 * (spawn), altCmd (fallback, e.g. no venv python), env.
 */

const REGISTRY = [
  {
    id: 'user-memory', label: 'User Memory', port: 3001,
    healthPath: '/service.health', logFile: 'user-memory.log',
    tier: 'protected',
    dir: 'mcp-services/thinkdrop-user-memory-service', entry: 'src/server.js',
    cmd: 'node', heap: 1024,
    env: { DB_PATH: 'mcp-services/thinkdrop-user-memory-service/data/user_memory.duckdb' },
  },
  {
    id: 'web-search', label: 'Web Search', port: 3002,
    healthPath: '/service.health', logFile: 'web-search.log',
    tier: 'warm',
    dir: 'mcp-services/thinkdrop-web-search', entry: 'src/index.js',
    cmd: 'node', heap: 256,
  },
  {
    id: 'conversation', label: 'Conversation', port: 3004,
    healthPath: '/health', logFile: 'conversation.log',
    tier: 'coldable',
    dir: 'mcp-services/conversation-service', entry: 'src/index.cjs',
    cmd: 'node', heap: 512,
  },
  {
    id: 'coreference', label: 'Coreference', port: 3005,
    healthPath: '/health', logFile: 'coreference.log',
    tier: 'coldable',
    dir: 'mcp-services/coreference-service', entry: 'server.py',
    cmd: 'venv/bin/python', altCmd: 'python3',
  },
  {
    id: 'voice', label: 'Voice', port: 3006,
    healthPath: '/health', logFile: 'voice-service.log',
    tier: 'coldable',
    dir: 'mcp-services/voice-service', entry: 'src/server.cjs',
    cmd: 'node', heap: 512,
  },
  {
    id: 'command', label: 'Command', port: 3007,
    healthPath: '/health', logFile: 'command.log',
    tier: 'warm',
    dir: 'mcp-services/command-service', entry: 'src/server.cjs',
    cmd: 'node',
  },
  {
    id: 'screen-intelligence', label: 'Screen Intelligence', port: 3008,
    healthPath: '/service.health', logFile: 'screen-intelligence.log',
    tier: 'coldable',
    dir: 'mcp-services/screen-intelligence-service', entry: 'src/server.js',
    cmd: 'node', heap: 256,
  },
  {
    id: 'phi4', label: 'Phi4 Decisions', port: 3009,
    healthPath: '/service.health', logFile: 'phi4.log',
    tier: 'protected',
    dir: 'mcp-services/thinkdrop-phi4-service', entry: 'src/server.js',
    cmd: 'node', heap: 768,
  },
  {
    id: 'personality', label: 'Personality', port: 3012,
    healthPath: '/health', logFile: 'personality.log',
    tier: 'coldable',
    dir: 'mcp-services/personality-service', entry: 'src/server.cjs',
    cmd: 'node', heap: 256,
  },
  {
    id: 'comms-graph', label: 'Comms Graph', port: 3015,
    healthPath: '/health', logFile: 'comms-graph.log',
    tier: 'warm',
    dir: 'comms-graph', entry: 'src/server.cjs',
    cmd: 'node', heap: 1024,
    env: { THINKDROP_PROJECT_ROOT: '.' },
  },
  {
    id: 'thinkdrop-backend', label: 'ThinkDrop Backend', port: 4000,
    healthPath: '/health', logFile: 'backend.log',
    tier: 'external',
  },
  {
    id: 'ollama', label: 'Ollama', port: 11434,
    healthPath: '/api/version', logFile: 'ollama.log',
    tier: 'external',
  },
];

const byId = new Map(REGISTRY.map(s => [s.id, s]));
const byPort = new Map(REGISTRY.map(s => [s.port, s]));

module.exports = {
  REGISTRY,
  get: (id) => byId.get(id) || null,
  getByPort: (port) => byPort.get(Number(port)) || null,
  coldable: () => REGISTRY.filter(s => s.tier === 'coldable'),
  spawnable: () => REGISTRY.filter(s => !!s.entry),
};
