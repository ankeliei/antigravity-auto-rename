/**
 * @fileoverview Antigravity Auto Rename Sidecar HTTP service, background conversation watcher,
 * and CDP window overlay bridge coordinator.
 */

import { existsSync, promises as fsPromises, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONFIG_FILE,
  PANEL_DIR,
  STATE_FILE,
  computeRuntimeCodeVersion,
  getConversationState,
  loadSettings,
  loadState,
  sanitizeSettings,
  saveSettings,
  updateConversationState,
} from './core/config.mjs';
import {
  discoverLanguageServer,
  getDefaultTranscriptPath,
  listConversations,
  readTranscriptMessages,
} from './core/ls-client.mjs';
import {
  buildRenamePrompt,
  detectInitiationLanguage,
  extractConversationContext,
} from './core/prompt-builder.mjs';
import {
  executeConversationRename,
  shouldTriggerAutoRename,
  undoConversationRename,
} from './core/rename-engine.mjs';
import { createWindowBridgeController } from './core/window-bridge.mjs';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
const WATCHER_INTERVAL_MS = 4000;
const RECENT_ACTIVITY_WINDOW_MS = 90_000;

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const fallbackPath = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
    if (existsSync(fallbackPath)) {
      return await import(pathToFileURL(fallbackPath).href);
    }
    return null;
  }
}

export async function readPanelAsset(relPath) {
  const fullPath = join(PANEL_DIR, relPath);
  if (fsPromises?.readFile) {
    return fsPromises.readFile(fullPath, 'utf8');
  }
  return readFileSync(fullPath, 'utf8');
}

function computeTurnsUntilNextRename(userTurnCount, lastRenamedTurn, settings) {
  if (!settings.enabled) return null;
  if (userTurnCount <= 0) return settings.hookFirstTurn ? 1 : null;
  if (userTurnCount === 1 && settings.hookFirstTurn && lastRenamedTurn < 1) return 0;
  const interval = Number(settings.autoRenameInterval || 0);
  if (interval <= 0) return null;
  const anchor = lastRenamedTurn > 0 ? lastRenamedTurn : 1;
  const remaining = interval - (userTurnCount - anchor);
  return Math.max(0, remaining);
}

function enrichConversationItem(conv, savedState, settings) {
  const transcript = readTranscriptMessages(getDefaultTranscriptPath(conv.cascadeId));
  const userTurnCount = transcript?.userMessages?.length || Number(savedState?.userTurnCount || 0);
  const firstRaw = transcript?.userMessages?.[0] || savedState?.firstUserMessage || '';
  const langInfo = firstRaw
    ? detectInitiationLanguage(firstRaw)
    : savedState?.initiationLanguage
      ? { code: savedState.initiationLanguage, label: savedState.initiationLanguage === 'zh' ? '中文' : savedState.initiationLanguage === 'en' ? 'English' : savedState.initiationLanguage }
      : { code: 'other', label: '未知' };
  const lastRenamedTurn = Number(savedState?.lastRenamedTurn || 0);
  return {
    cascadeId: conv.cascadeId,
    title: conv.effectiveTitle,
    annotationTitle: conv.annotationTitle,
    summaryTitle: conv.summary,
    status: conv.status,
    stepCount: conv.stepCount,
    lastModifiedMs: conv.lastModifiedMs,
    lastModifiedTime: conv.lastModifiedTime,
    userTurnCount,
    initiationLanguage: langInfo,
    lastRenamedTurn,
    previousTitle: savedState?.previousTitle || '',
    canUndo: Boolean(savedState?.previousTitle && savedState.previousTitle !== conv.effectiveTitle),
    lastRenameSource: savedState?.lastRenameSource || '',
    turnsUntilAutoRename: computeTurnsUntilNextRename(userTurnCount, lastRenamedTurn, settings),
  };
}

/**
 * Handles all `/api/*` requests uniformly across Sidecar Webview, Window Overlay Bridge, and tests.
 */
export function createApiDispatcher({ sidecarApp = null, bridgeControllerRef = { current: null } } = {}) {
  async function handleStatus(data = {}) {
    const settings = loadSettings(CONFIG_FILE);
    const stateMap = loadState(STATE_FILE).conversations;
    const ep = await discoverLanguageServer().catch(() => null);
    let conversations = [];
    let lsError = '';
    try {
      conversations = await listConversations();
    } catch (err) {
      lsError = err?.message || '无法连接 Language Server';
    }

    const requestedId = String(
      data?.conversationId || sidecarApp?.config?.conversationId || ''
    ).trim();
    const recentRaw = conversations.slice(0, 20);
    if (requestedId && !recentRaw.some((c) => c.cascadeId === requestedId)) {
      const target = conversations.find((c) => c.cascadeId === requestedId);
      if (target) recentRaw.unshift(target);
    }

    const recentConversations = recentRaw.map((c) =>
      enrichConversationItem(c, stateMap[c.cascadeId] || null, settings)
    );

    const activeConversation =
      (requestedId && recentConversations.find((c) => c.cascadeId === requestedId)) ||
      recentConversations[0] ||
      (requestedId
        ? {
            cascadeId: requestedId,
            title: stateMap[requestedId]?.currentTitle || '当前会话',
            userTurnCount: Number(stateMap[requestedId]?.userTurnCount || 0),
            initiationLanguage: {
              code: stateMap[requestedId]?.initiationLanguage || 'other',
              label: stateMap[requestedId]?.initiationLanguage === 'zh' ? '中文' : 'Auto',
            },
            canUndo: Boolean(stateMap[requestedId]?.previousTitle),
          }
        : null);

    return {
      status: 200,
      contentType: 'application/json',
      headers: NO_STORE_HEADERS,
      body: JSON.stringify({
        ok: true,
        lsConnected: Boolean(ep?.baseUrl && !lsError),
        lsError,
        settings,
        activeConversation,
        recentConversations,
      }),
    };
  }

  async function handleSettings(data = {}) {
    const res = saveSettings(data, CONFIG_FILE);
    if (!res.ok) {
      return {
        status: 500,
        contentType: 'application/json',
        headers: NO_STORE_HEADERS,
        body: JSON.stringify({ ok: false, error: '保存配置失败' }),
      };
    }
    if (res.settings.enableWindowOverlay !== res.previous.enableWindowOverlay) {
      void bridgeControllerRef.current?.notifySettingChanged(res.settings.enableWindowOverlay);
    }
    return {
      status: 200,
      contentType: 'application/json',
      headers: NO_STORE_HEADERS,
      body: JSON.stringify({ ok: true, settings: res.settings }),
    };
  }

  async function resolveTargetCascadeId(data = {}) {
    const explicit = String(data?.cascadeId || data?.conversationId || '').trim();
    if (explicit) return explicit;
    const fromEnv = String(sidecarApp?.config?.conversationId || '').trim();
    if (fromEnv) return fromEnv;
    const convs = await listConversations().catch(() => []);
    return convs[0]?.cascadeId || '';
  }

  async function handleRename(data = {}) {
    const cascadeId = await resolveTargetCascadeId(data);
    if (!cascadeId) {
      return {
        status: 400,
        contentType: 'application/json',
        headers: NO_STORE_HEADERS,
        body: JSON.stringify({ ok: false, error: '当前没有可重命名的活跃会话' }),
      };
    }
    const customTitle = data?.customTitle !== undefined ? data.customTitle : null;
    const out = await executeConversationRename({
      cascadeId,
      customTitle,
      reason: customTitle !== null ? 'manual_input' : 'manual',
      force: true,
    });
    return {
      status: out.ok ? 200 : 409,
      contentType: 'application/json',
      headers: NO_STORE_HEADERS,
      body: JSON.stringify(out),
    };
  }

  async function handleUndoRename(data = {}) {
    const cascadeId = await resolveTargetCascadeId(data);
    const out = await undoConversationRename({ cascadeId });
    return {
      status: 200,
      contentType: 'application/json',
      headers: NO_STORE_HEADERS,
      body: JSON.stringify(out),
    };
  }

  async function handlePreviewPrompt(data = {}) {
    const draftSettings = sanitizeSettings(data?.settings || {}, loadSettings(CONFIG_FILE));
    const cascadeId = await resolveTargetCascadeId(data);
    let context;
    if (cascadeId && !data?.sampleText) {
      context = await extractConversationContext({
        cascadeId,
        recentTurnsLimit: draftSettings.contextRecentTurns,
      });
    } else {
      const sample = String(
        data?.sampleText || '我想在 Antigravity 里写一个自动按用户语言给会话重命名的插件'
      );
      const lang = detectInitiationLanguage(sample);
      context = {
        cascadeId: 'preview',
        userTurnCount: 1,
        firstUserMessage: sample,
        recentUserMessages: [{ turn: 1, text: sample }],
        latestAssistantSnippet: '',
        initiationLanguage: lang,
        workspaceName: 'antigravity-auto-rename',
      };
    }
    const prompt = buildRenamePrompt(context, draftSettings);
    return {
      status: 200,
      contentType: 'application/json',
      headers: NO_STORE_HEADERS,
      body: JSON.stringify({
        ok: true,
        prompt,
        initiationLanguage: context.initiationLanguage,
        userTurnCount: context.userTurnCount,
      }),
    };
  }

  return async function dispatchApiRequest(pathname, method, data = {}) {
    try {
      if (pathname === '/api/status' && method === 'GET') return await handleStatus(data);
      if (pathname === '/api/settings' && method === 'POST') return await handleSettings(data);
      if (pathname === '/api/rename' && method === 'POST') return await handleRename(data);
      if (pathname === '/api/undo-rename' && method === 'POST') return await handleUndoRename(data);
      if (pathname === '/api/preview-prompt' && method === 'POST') return await handlePreviewPrompt(data);
      return {
        status: 404,
        contentType: 'application/json',
        headers: NO_STORE_HEADERS,
        body: JSON.stringify({ ok: false, error: 'Not found' }),
      };
    } catch (err) {
      return {
        status: 500,
        contentType: 'application/json',
        headers: NO_STORE_HEADERS,
        body: JSON.stringify({ ok: false, error: err?.message || 'Internal error' }),
      };
    }
  };
}

let watcherInFlight = false;

/**
 * Periodic safety-net watcher: checks recently active conversations so first-turn preemption
 * and every-N-turn auto-renaming work even if hooks have not fired in an already-open session.
 */
export async function runWatcherSweep() {
  if (watcherInFlight) return;
  watcherInFlight = true;
  try {
    const settings = loadSettings(CONFIG_FILE);
    if (!settings.enabled) return;

    const convs = await listConversations().catch(() => []);
    const now = Date.now();
    const recent = convs.filter((c) => c.lastModifiedMs > 0 && now - c.lastModifiedMs < RECENT_ACTIVITY_WINDOW_MS);

    for (const conv of recent.slice(0, 5)) {
      const transcript = readTranscriptMessages(getDefaultTranscriptPath(conv.cascadeId));
      const turns = transcript?.userMessages?.length || 0;
      if (turns <= 0) continue;

      const convState = getConversationState(conv.cascadeId, STATE_FILE);
      const decision = shouldTriggerAutoRename({
        eventPhase: 'watcher',
        userTurnCount: turns,
        convState,
        settings,
      });

      if (turns !== Number(convState?.userTurnCount || 0)) {
        updateConversationState(conv.cascadeId, { userTurnCount: turns }, STATE_FILE);
      }

      if (decision.trigger) {
        await executeConversationRename({
          cascadeId: conv.cascadeId,
          reason: decision.reason === 'first_turn' ? 'first_turn' : 'watcher',
        }).catch(() => {});
      }
    }
  } finally {
    watcherInFlight = false;
  }
}

async function startSidecarRuntime() {
  const sdk = await loadSidecarSdk();
  const hasSidecarEnv = Boolean(
    sdk &&
    process.env.ANTIGRAVITY_LS_ADDRESS &&
    process.env.ANTIGRAVITY_CSRF_TOKEN &&
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
  );

  const bootBundleVersion = computeRuntimeCodeVersion();
  const bridgeControllerRef = { current: null };

  if (hasSidecarEnv) {
    const { SidecarApp, Response } = sdk;
    const app = new SidecarApp();
    const dispatchApi = createApiDispatcher({ sidecarApp: app, bridgeControllerRef });

    const wrapResponse = (out) =>
      new Response(out.body, {
        status: out.status,
        contentType: out.contentType,
        headers: out.headers,
      });

    app.page('/', async () => new Response(await readPanelAsset('web/index.html'), { contentType: 'text/html; charset=utf-8', headers: NO_STORE_HEADERS }));
    app.page('/styles.css', async () => new Response(await readPanelAsset('web/styles.css'), { contentType: 'text/css; charset=utf-8', headers: NO_STORE_HEADERS }));
    app.page('/app.js', async () => new Response(await readPanelAsset('web/app.js'), { contentType: 'application/javascript; charset=utf-8', headers: NO_STORE_HEADERS }));

    app.api('/api/status', async (data) => wrapResponse(await dispatchApi('/api/status', 'GET', data)), 'GET');
    app.api('/api/settings', async (data) => wrapResponse(await dispatchApi('/api/settings', 'POST', data)), 'POST');
    app.api('/api/rename', async (data) => wrapResponse(await dispatchApi('/api/rename', 'POST', data)), 'POST');
    app.api('/api/undo-rename', async (data) => wrapResponse(await dispatchApi('/api/undo-rename', 'POST', data)), 'POST');
    app.api('/api/preview-prompt', async (data) => wrapResponse(await dispatchApi('/api/preview-prompt', 'POST', data)), 'POST');

    await app.run();

    const bridge = createWindowBridgeController({
      handleApiRequest: dispatchApi,
      readAssetFn: readPanelAsset,
      bootBundleVersion,
      onVersionDrift: () => {
        setTimeout(() => process.exit(0), 150);
      },
    });
    bridgeControllerRef.current = bridge;
    bridge.start();

    const watcherTimer = setInterval(() => {
      void runWatcherSweep();
    }, WATCHER_INTERVAL_MS);
    watcherTimer.unref?.();
    return;
  }

  // Standalone CLI / test verification mode when launched directly without Antigravity sidecar env
  const dispatchApi = createApiDispatcher({ bridgeControllerRef });
  const port = Number(process.env.PORT || 0);
  const srv = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE_HEADERS });
      res.end(await readPanelAsset('web/index.html'));
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/styles.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', ...NO_STORE_HEADERS });
      res.end(await readPanelAsset('web/styles.css'));
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE_HEADERS });
      res.end(await readPanelAsset('web/app.js'));
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE_HEADERS });
      res.end('window.sidecar = window.sidecar || { fetch: (u, o) => fetch(u, o) };');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let data = {};
    if (req.method === 'GET') {
      data = Object.fromEntries(parsedUrl.searchParams.entries());
    } else if (chunks.length > 0) {
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        data = {};
      }
    }
    const out = await dispatchApi(parsedUrl.pathname, req.method || 'GET', data);
    res.writeHead(out.status || 200, { 'Content-Type': out.contentType || 'application/json', ...(out.headers || {}) });
    res.end(out.body);
  });

  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  const actualPort = srv.address()?.port;
  console.log(`[auto-rename] standalone mode listening on http://127.0.0.1:${actualPort}`);

  const bridge = createWindowBridgeController({
    handleApiRequest: dispatchApi,
    readAssetFn: readPanelAsset,
    bootBundleVersion,
  });
  bridgeControllerRef.current = bridge;
  bridge.start();

  const watcherTimer = setInterval(() => {
    void runWatcherSweep();
  }, WATCHER_INTERVAL_MS);
  watcherTimer.unref?.();
}

const isEntryModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryModule) {
  void startSidecarRuntime();
}
