/**
 * @fileoverview Cross-platform configuration, conversation rename state persistence,
 * and runtime bundle fingerprinting for the Antigravity Auto Rename plugin.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = dirname(fileURLToPath(import.meta.url));
export const PANEL_DIR = dirname(CORE_DIR);
export const PLUGIN_ROOT_DIR = dirname(dirname(PANEL_DIR));

/**
 * Default plugin configuration values.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  hookFirstTurn: true,
  autoRenameInterval: 5,
  contextRecentTurns: 5,
  includeAssistantSummary: true,
  triggerTiming: 'pre',
  enableWindowOverlay: true,
  preferInitiationLanguage: true,
  keepTechTerms: true,
  addWorkspacePrefix: false,
  addEmojiPrefix: false,
  maxTitleCharsZh: 14,
  maxTitleWordsEn: 6,
  modelEnum: 1050,
  customPromptRules:
    '会话命名优先采用用户发起会话所采用的语言（例如用户首条消息使用中文，则必须输出简明自然的中文标题；若使用英文则输出英文标题）。保留关键技术名词、缩写与文件名，不要包含引号、书名号、Markdown格式或“会话标题：”等前缀。',
  systemPromptTemplate: '',
});

/**
 * Resolves the persistent data directory for plugin settings, state, and caches.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @returns {string}
 */
export function resolveDataDir(env = process.env, homeDir = homedir()) {
  const customDir = String(env?.AUTO_RENAME_DATA_DIR || env?.PLUGIN_DATA || '').trim();
  if (customDir) return customDir;
  return join(homeDir, '.gemini', 'antigravity', 'auto-rename');
}

/**
 * Resolves the Antigravity brain directory where per-conversation transcripts live.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @returns {string}
 */
export function resolveBrainDir(env = process.env, homeDir = homedir()) {
  const customDir = String(env?.ANTIGRAVITY_BRAIN_DIR || '').trim();
  if (customDir) return customDir;
  return join(homeDir, '.gemini', 'antigravity', 'brain');
}

/**
 * Resolves standard file paths inside a data directory.
 *
 * @param {string} [dataDir=resolveDataDir()]
 */
export function getDataPaths(dataDir = resolveDataDir()) {
  return {
    dataDir,
    configFile: join(dataDir, 'config.json'),
    stateFile: join(dataDir, 'state.json'),
    lsCacheFile: join(dataDir, 'ls-endpoint-cache.json'),
    bridgeLeaseFile: join(dataDir, 'window-bridge-lease.json'),
  };
}

export const DATA_DIR = resolveDataDir();
export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const STATE_FILE = join(DATA_DIR, 'state.json');
export const LS_CACHE_FILE = join(DATA_DIR, 'ls-endpoint-cache.json');
export const BRIDGE_LEASE_FILE = join(DATA_DIR, 'window-bridge-lease.json');

/**
 * Reads and parses a JSON file, returning fallback on error or missing file.
 *
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {T}
 */
export function loadJson(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Atomically persists a JSON-serializable value using write-to-temp then rename.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @returns {boolean}
 */
export function saveJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(data, null, 2) + '\n';
    const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
    writeFileSync(tmpPath, serialized, 'utf8');
    try {
      renameSync(tmpPath, filePath);
    } catch {
      // Windows or synced folders can lock rename transiently; fallback to direct write and clean temp
      writeFileSync(filePath, serialized, 'utf8');
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore temp cleanup errors
      }
    }
    return true;
  } catch {
    return false;
  }
}

function clampInt(val, fallback, min, max) {
  if (val === undefined || val === null || val === '') return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.floor(num);
  return Math.max(min, Math.min(max, intVal));
}

/**
 * Normalizes and validates user settings against schema defaults.
 *
 * @param {Record<string, any>} raw
 * @param {Record<string, any>} [base=DEFAULT_SETTINGS]
 */
export function sanitizeSettings(raw, base = DEFAULT_SETTINGS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const prev = base && typeof base === 'object' ? { ...DEFAULT_SETTINGS, ...base } : { ...DEFAULT_SETTINGS };
  const boolOr = (key) => (typeof src[key] === 'boolean' ? src[key] : Boolean(prev[key]));
  const strOr = (key, maxLen) => {
    if (typeof src[key] !== 'string') return String(prev[key] ?? '');
    return src[key].slice(0, maxLen);
  };
  const timing = src.triggerTiming === 'stop' || src.triggerTiming === 'pre'
    ? src.triggerTiming
    : prev.triggerTiming === 'stop'
      ? 'stop'
      : 'pre';

  return {
    enabled: boolOr('enabled'),
    hookFirstTurn: boolOr('hookFirstTurn'),
    autoRenameInterval: clampInt(src.autoRenameInterval, prev.autoRenameInterval, 0, 100),
    contextRecentTurns: clampInt(src.contextRecentTurns, prev.contextRecentTurns, 1, 20),
    includeAssistantSummary: boolOr('includeAssistantSummary'),
    triggerTiming: timing,
    enableWindowOverlay: boolOr('enableWindowOverlay'),
    preferInitiationLanguage: boolOr('preferInitiationLanguage'),
    keepTechTerms: boolOr('keepTechTerms'),
    addWorkspacePrefix: boolOr('addWorkspacePrefix'),
    addEmojiPrefix: boolOr('addEmojiPrefix'),
    maxTitleCharsZh: clampInt(src.maxTitleCharsZh, prev.maxTitleCharsZh, 6, 40),
    maxTitleWordsEn: clampInt(src.maxTitleWordsEn, prev.maxTitleWordsEn, 2, 16),
    modelEnum: clampInt(src.modelEnum, prev.modelEnum, 0, 100000),
    customPromptRules: strOr('customPromptRules', 4000),
    systemPromptTemplate: strOr('systemPromptTemplate', 8000),
  };
}

/**
 * Loads settings merged with defaults.
 *
 * @param {string} [configFile=CONFIG_FILE]
 */
export function loadSettings(configFile = CONFIG_FILE) {
  const saved = loadJson(configFile, {});
  return sanitizeSettings(saved, DEFAULT_SETTINGS);
}

/**
 * Validates and saves partial or full settings updates.
 *
 * @param {Record<string, any>} patch
 * @param {string} [configFile=CONFIG_FILE]
 */
export function saveSettings(patch, configFile = CONFIG_FILE) {
  const current = loadSettings(configFile);
  const next = sanitizeSettings(patch, current);
  const ok = saveJsonAtomic(configFile, next);
  return { ok, settings: next, previous: current };
}

/**
 * Loads the persisted conversation state map keyed by cascadeId.
 *
 * @param {string} [stateFile=STATE_FILE]
 * @returns {{ conversations: Record<string, any> }}
 */
export function loadState(stateFile = STATE_FILE) {
  const raw = loadJson(stateFile, null);
  if (!raw || typeof raw !== 'object' || !raw.conversations || typeof raw.conversations !== 'object') {
    return { conversations: {} };
  }
  return { conversations: raw.conversations };
}

/**
 * Reads a single conversation's rename tracking state.
 *
 * @param {string} cascadeId
 * @param {string} [stateFile=STATE_FILE]
 */
export function getConversationState(cascadeId, stateFile = STATE_FILE) {
  if (!cascadeId) return null;
  const st = loadState(stateFile);
  return st.conversations[cascadeId] || null;
}

/**
 * Updates a single conversation's state and prunes oldest entries above limit.
 *
 * @param {string} cascadeId
 * @param {Record<string, any>} patch
 * @param {string} [stateFile=STATE_FILE]
 */
export function updateConversationState(cascadeId, patch, stateFile = STATE_FILE) {
  if (!cascadeId) return null;
  const state = loadState(stateFile);
  const prev = state.conversations[cascadeId] || { cascadeId };
  const next = {
    ...prev,
    ...patch,
    cascadeId,
    updatedAtMs: Date.now(),
  };
  state.conversations[cascadeId] = next;

  const entries = Object.entries(state.conversations);
  if (entries.length > 300) {
    entries.sort((a, b) => Number(b[1]?.updatedAtMs || 0) - Number(a[1]?.updatedAtMs || 0));
    state.conversations = Object.fromEntries(entries.slice(0, 250));
  }
  saveJsonAtomic(stateFile, state);
  return next;
}

/**
 * Computes a deterministic bundle version string from frontend overlay files
 * so window-bridge can detect updates and hot-reinject cleanly.
 *
 * @returns {string}
 */
export function computeRuntimeCodeVersion() {
  const files = [
    join(PANEL_DIR, 'web', 'overlay.js'),
    join(PANEL_DIR, 'web', 'styles.css'),
    join(PANEL_DIR, 'main.mjs'),
  ];
  let maxMtimeMs = 0;
  for (const filePath of files) {
    try {
      const st = statSync(filePath);
      if (st.mtimeMs > maxMtimeMs) {
        maxMtimeMs = st.mtimeMs;
      }
    } catch {
      // Ignore missing asset during partial startup
    }
  }
  return String(Math.floor(maxMtimeMs) || Date.now());
}
