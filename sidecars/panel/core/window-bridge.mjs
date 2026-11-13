/**
 * @fileoverview Non-invasive CDP Window Overlay bridge controller for mounting a
 * quick "✨ 重命名" button & popover inside Antigravity's main window titlebar.
 *
 * Strictly isolated from other plugins (e.g., usage-monitor) using dedicated globals
 * (`__AGAutoRenameBridge`, `__AGAutoRenameOverlay`) and dedicated auth header
 * (`X-Auto-Rename-Token`), and never modifies Antigravity's `app.asar`.
 */

import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_LEASE_FILE,
  computeRuntimeCodeVersion,
  loadJson,
  loadSettings,
  saveJsonAtomic,
} from './config.mjs';

const BRIDGE_MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_BRIDGE_PATHS = new Set([
  '/api/status',
  '/api/settings',
  '/api/rename',
  '/api/undo-rename',
  '/api/preview-prompt',
]);

/**
 * Resolves OS-specific paths where Electron/Antigravity writes `DevToolsActivePort`.
 */
export function resolveDevToolsPortCandidates(
  env = process.env,
  platform = process.platform,
  homeDir = homedir()
) {
  const explicitFile = String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '').trim();
  if (explicitFile) return [explicitFile];
  if (platform === 'win32') {
    const appData = env?.APPDATA || join(homeDir, 'AppData', 'Roaming');
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    return [
      join(appData, 'Antigravity', 'DevToolsActivePort'),
      join(localAppData, 'Antigravity', 'DevToolsActivePort'),
    ];
  }
  if (platform === 'darwin') {
    return [join(homeDir, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')];
  }
  const configHome = env?.XDG_CONFIG_HOME || join(homeDir, '.config');
  return [join(configHome, 'Antigravity', 'DevToolsActivePort')];
}

export function parseDevToolsPortFile(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const firstLine = rawText.split(/\r?\n/)[0]?.trim() || '';
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function isAntigravityMainPageTarget(target) {
  if (!target || typeof target !== 'object' || target.type !== 'page') return false;
  const url = String(target.url || '').trim();
  const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
  if (!/^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(url)) return false;
  if (!/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(wsUrl)) return false;
  return true;
}

export function isAllowedBridgeOrigin(origin) {
  const text = String(origin || '').trim();
  return /^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(text);
}

function verifyBridgeToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Creates the loopback HTTP bridge & CDP window injection controller.
 */
export function createWindowBridgeController(options) {
  const {
    handleApiRequest,
    readAssetFn,
    getSettingsFn = () => loadSettings(),
    getBundleVersionFn = computeRuntimeCodeVersion,
    env = process.env,
    platform = process.platform,
    homeDir = homedir(),
    pollIntervalMs = 3000,
    fastPollIntervalMs = 1500,
    cdpTimeoutMs = 3500,
    bootBundleVersion = '',
    onVersionDrift = null,
    leaseFilePath = BRIDGE_LEASE_FILE,
    WebSocketImpl = globalThis.WebSocket,
  } = options || {};

  let server = null;
  let serverStartPromise = null;
  let bridgePort = 0;
  let bridgeToken = '';
  let pollTimer = null;
  let initialTimer = null;
  let stopped = false;
  let syncInFlight = null;
  let hadInjectedTargets = false;
  let cdpFallbackActive = false;

  function applyCorsHeaders(res, origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auto-Rename-Token');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
  }

  async function executeRpcBatch(rpcBatch) {
    const responses = [];
    for (const item of rpcBatch) {
      const reqId = String(item?.id || '');
      if (!reqId) continue;
      try {
        const parsedUrl = new URL(String(item.path || '/'), 'http://127.0.0.1');
        if (!ALLOWED_BRIDGE_PATHS.has(parsedUrl.pathname)) {
          responses.push({ id: reqId, ok: false, status: 404, error: 'Not found' });
          continue;
        }
        const method = String(item.method || 'GET').toUpperCase();
        const reqData =
          method === 'GET'
            ? Object.fromEntries(parsedUrl.searchParams.entries())
            : item.body && typeof item.body === 'object'
              ? item.body
              : {};
        const out = await handleApiRequest(parsedUrl.pathname, method, reqData);
        const status = Number(out?.status || 200);
        const parsedBody = out?.body ? JSON.parse(out.body) : {};
        if (status >= 200 && status < 300) {
          responses.push({ id: reqId, ok: true, status, data: parsedBody });
        } else {
          responses.push({
            id: reqId,
            ok: false,
            status,
            error: parsedBody?.error || `HTTP ${status}`,
          });
        }
      } catch (err) {
        responses.push({
          id: reqId,
          ok: false,
          status: 500,
          error: err?.message || 'Internal bridge error',
        });
      }
    }
    return responses;
  }

  async function ensureBridgeServer() {
    if (server && bridgePort > 0) return { port: bridgePort, token: bridgeToken };
    if (serverStartPromise) return serverStartPromise;

    serverStartPromise = (async () => {
      if (!bridgeToken) {
        bridgeToken = crypto.randomBytes(32).toString('hex');
      }

      const srv = http.createServer((req, res) => {
        const origin = String(req.headers.origin || '').trim();
        if (!isAllowedBridgeOrigin(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden origin' }));
          return;
        }

        const hostHeader = String(req.headers.host || '').trim().toLowerCase();
        if (
          hostHeader &&
          hostHeader !== `127.0.0.1:${bridgePort}` &&
          hostHeader !== `localhost:${bridgePort}` &&
          hostHeader !== `[::1]:${bridgePort}`
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden host' }));
          return;
        }

        applyCorsHeaders(res, origin);

        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${bridgePort}`);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Malformed URL' }));
          return;
        }

        if (!ALLOWED_BRIDGE_PATHS.has(parsedUrl.pathname)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        const headerToken = String(req.headers['x-auto-rename-token'] || '');
        if (!verifyBridgeToken(headerToken, bridgeToken)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid bridge token' }));
          return;
        }

        if (method === 'GET') {
          const queryData = Object.fromEntries(parsedUrl.searchParams.entries());
          Promise.resolve(handleApiRequest(parsedUrl.pathname, 'GET', queryData))
            .then((out) => {
              res.writeHead(out.status || 200, {
                'Content-Type': out.contentType || 'application/json',
                ...(out.headers || {}),
              });
              res.end(out.body);
            })
            .catch(() => {
              if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal bridge error' }));
            });
          return;
        }

        if (method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        let aborted = false;
        req.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > BRIDGE_MAX_BODY_BYTES) {
            aborted = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (aborted) return;
          let bodyObj = {};
          try {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            bodyObj = raw ? JSON.parse(raw) : {};
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          Promise.resolve(handleApiRequest(parsedUrl.pathname, 'POST', bodyObj))
            .then((out) => {
              res.writeHead(out.status || 200, {
                'Content-Type': out.contentType || 'application/json',
                ...(out.headers || {}),
              });
              res.end(out.body);
            })
            .catch(() => {
              if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal bridge error' }));
            });
        });
      });

      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          srv.removeListener('error', reject);
          resolve();
        });
      });
      srv.unref?.();
      const addr = srv.address();
      bridgePort = typeof addr === 'object' && addr ? Number(addr.port || 0) : 0;
      server = srv;
      return { port: bridgePort, token: bridgeToken };
    })().finally(() => {
      serverStartPromise = null;
    });

    return serverStartPromise;
  }

  function findActiveDevToolsPort() {
    const candidates = resolveDevToolsPortCandidates(env, platform, homeDir);
    for (const filePath of candidates) {
      try {
        if (!existsSync(filePath)) continue;
        const port = parseDevToolsPortFile(readFileSync(filePath, 'utf8'));
        if (port) return port;
      } catch {
        // Ignore unreadable candidates
      }
    }
    return null;
  }

  async function listMainWindowTargets(cdpPort) {
    const rawBody = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${cdpPort}/json/list`, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`CDP HTTP ${res.statusCode}`));
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      });
      req.setTimeout(1500, () => req.destroy(new Error('CDP list timeout')));
      req.on('error', reject);
    });
    const parsed = JSON.parse(rawBody);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAntigravityMainPageTarget);
  }

  async function evaluateOnTarget(wsUrl, expression) {
    const WS = WebSocketImpl || globalThis.WebSocket;
    if (typeof WS !== 'function') throw new Error('WebSocket runtime unavailable');
    let ws = null;
    let timer = null;
    try {
      ws = new WS(wsUrl);
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CDP Runtime.evaluate timeout')), cdpTimeoutMs);
        ws.addEventListener(
          'open',
          () => {
            try {
              ws.send(
                JSON.stringify({
                  id: 1,
                  method: 'Runtime.evaluate',
                  params: { expression, returnByValue: true, awaitPromise: true },
                })
              );
            } catch (err) {
              reject(err);
            }
          },
          { once: true }
        );
        ws.addEventListener('message', (ev) => {
          try {
            const raw = typeof ev?.data === 'string' ? ev.data : String(ev?.data || '');
            const msg = JSON.parse(raw);
            if (msg && msg.id === 1) resolve(msg);
          } catch {
            // Ignore unrelated frames
          }
        });
        ws.addEventListener(
          'error',
          (err) => reject(err instanceof Error ? err : new Error('CDP WebSocket error')),
          { once: true }
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // Ignore close error
      }
    }
  }

  async function runSyncInternal({ forceReinject = false } = {}) {
    if (stopped) return { ok: false, reason: 'stopped' };
    const bundleVersion = String(getBundleVersionFn() || '');
    if (bootBundleVersion && bundleVersion && bundleVersion !== String(bootBundleVersion)) {
      onVersionDrift?.();
      return { ok: false, reason: 'version_drift_restarting', injected: 0 };
    }

    const enabled = Boolean(getSettingsFn()?.enableWindowOverlay !== false);
    if (enabled && leaseFilePath && !forceReinject) {
      const lease = loadJson(leaseFilePath, null);
      const leasePid = Number(lease?.pid || 0);
      const leaseAgeMs = Date.now() - Number(lease?.updatedAtMs || 0);
      if (leasePid > 0 && leasePid !== process.pid && leaseAgeMs >= 0 && leaseAgeMs < 9000 && isPidAlive(leasePid)) {
        const leaseVerNum = Number(lease?.bundleVersion) || 0;
        const myVerNum = Number(bundleVersion) || 0;
        if (leaseVerNum > myVerNum) {
          onVersionDrift?.();
          return { ok: false, enabled: true, reason: 'older_than_leader', injected: 0 };
        }
        if (leaseVerNum === myVerNum || String(lease?.bundleVersion || '') === bundleVersion) {
          return { ok: true, enabled: true, reason: 'follower_yield', leaderPid: leasePid, injected: 0 };
        }
      }
      saveJsonAtomic(leaseFilePath, { pid: process.pid, bundleVersion, updatedAtMs: Date.now() });
    }

    const cdpPort = findActiveDevToolsPort();
    if (!cdpPort) return { ok: false, enabled, reason: 'no_devtools_port', injected: 0 };

    let targets = [];
    try {
      targets = await listMainWindowTargets(cdpPort);
    } catch {
      return { ok: false, enabled, reason: 'cdp_unreachable', injected: 0 };
    }
    if (!targets.length) return { ok: true, enabled, reason: 'no_targets', injected: 0 };

    if (!enabled) {
      if (!hadInjectedTargets && !forceReinject) return { ok: true, enabled: false, removed: 0 };
      const disposeExpr = `(() => {
        try {
          const existed = Boolean(window.__AGAutoRenameOverlay || window.__AGAutoRenameBridge);
          window.__AGAutoRenameOverlay?.dispose?.();
          delete window.__AGAutoRenameOverlay;
          delete window.__AGAutoRenameBridge;
          return existed;
        } catch { return false; }
      })()`;
      let removed = 0;
      for (const target of targets) {
        try {
          const res = await evaluateOnTarget(target.webSocketDebuggerUrl, disposeExpr);
          if (res?.result?.result?.value === true) removed += 1;
        } catch {
          // Non-fatal per target
        }
      }
      hadInjectedTargets = false;
      return { ok: true, enabled: false, removed };
    }

    const { port, token } = await ensureBridgeServer();
    const probeExpr = `(() => {
      try {
        const ov = window.__AGAutoRenameOverlay;
        const br = window.__AGAutoRenameBridge;
        const alive = Boolean(ov && typeof ov.ensureAlive === 'function' && ov.ensureAlive());
        const rpcBatch = Array.isArray(br?.rpcQueue) && br.rpcQueue.length > 0 ? br.rpcQueue.splice(0, 8) : [];
        return {
          alive,
          bundleVersion: String(ov?.bundleVersion || ''),
          bridgePort: Number(br?.port || 0),
          hasToken: Boolean(br?.token),
          transportMode: String(br?.transportMode || 'http'),
          rpcBatch,
        };
      } catch {
        return { alive: false, bundleVersion: '', bridgePort: 0, hasToken: false, transportMode: 'http', rpcBatch: [] };
      }
    })()`;

    let cachedAssets = null;
    let injected = 0;
    let aliveCount = 0;
    let sawCdpTransport = false;

    for (const target of targets) {
      try {
        if (!forceReinject) {
          const probeRes = await evaluateOnTarget(target.webSocketDebuggerUrl, probeExpr);
          const snap = probeRes?.result?.result?.value;
          if (snap && snap.alive === true && snap.bundleVersion === bundleVersion) {
            if (snap.bridgePort !== port || snap.hasToken !== true) {
              await evaluateOnTarget(
                target.webSocketDebuggerUrl,
                `window.__AGAutoRenameOverlay?.updateBridge?.(${JSON.stringify({ port, token })})`
              );
            }
            aliveCount += 1;
            hadInjectedTargets = true;
            if (snap.transportMode === 'cdp') sawCdpTransport = true;
            if (Array.isArray(snap.rpcBatch) && snap.rpcBatch.length > 0) {
              sawCdpTransport = true;
              const rpcResults = await executeRpcBatch(snap.rpcBatch);
              await evaluateOnTarget(
                target.webSocketDebuggerUrl,
                `window.__AGAutoRenameOverlay?.deliverRpc?.(${JSON.stringify(rpcResults)})`
              );
            }
            continue;
          }
        }

        if (!cachedAssets) {
          const [stylesCss, overlayJs] = await Promise.all([
            readAssetFn('web/styles.css'),
            readAssetFn('web/overlay.js'),
          ]);
          cachedAssets = { stylesCss, overlayJs };
        }

        let initialStatus = null;
        try {
          const routeMatch = String(target.url || '').match(/\/c\/([a-f0-9-]{36})(?:\/|$)/i);
          const initOut = await handleApiRequest('/api/status', 'GET', {
            conversationId: routeMatch ? routeMatch[1] : '',
          });
          if (Number(initOut?.status || 200) === 200 && initOut?.body) {
            initialStatus = JSON.parse(initOut.body);
          }
        } catch {
          // Non-fatal
        }

        const bridgeConfigJson = JSON.stringify({
          port,
          token,
          bundleVersion,
          stylesCss: cachedAssets.stylesCss,
          initialStatus,
        });
        const injectionScript = `(() => {\nwindow.__AGAutoRenameBridge = ${bridgeConfigJson};\n})();\n${cachedAssets.overlayJs}\nBoolean(window.__AGAutoRenameOverlay && window.__AGAutoRenameOverlay.ensureAlive && window.__AGAutoRenameOverlay.ensureAlive());`;

        const evalRes = await evaluateOnTarget(target.webSocketDebuggerUrl, injectionScript);
        if (evalRes && !evalRes.error && !evalRes.result?.exceptionDetails && evalRes.result?.result?.value === true) {
          injected += 1;
          aliveCount += 1;
          hadInjectedTargets = true;
        }
      } catch {
        // Non-fatal per window
      }
    }

    cdpFallbackActive = sawCdpTransport;
    return { ok: true, enabled: true, port, targets: targets.length, injected, aliveCount };
  }

  function syncAllWindows(opts = {}) {
    if (syncInFlight) {
      return syncInFlight.then(() => runSyncInternal(opts));
    }
    syncInFlight = runSyncInternal(opts).finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  }

  function scheduleNextPoll() {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    const delayMs = cdpFallbackActive ? fastPollIntervalMs : pollIntervalMs;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => scheduleNextPoll());
    }, delayMs);
    pollTimer.unref?.();
  }

  function start() {
    stopped = false;
    if (initialTimer) clearTimeout(initialTimer);
    if (pollTimer) clearTimeout(pollTimer);
    initialTimer = setTimeout(() => {
      initialTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => scheduleNextPoll());
    }, 350);
    initialTimer.unref?.();
  }

  async function stop({ disposeWindows = false } = {}) {
    if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (disposeWindows && hadInjectedTargets) {
      const prevStopped = stopped;
      stopped = false;
      try {
        const cdpPort = findActiveDevToolsPort();
        if (cdpPort) {
          const targets = await listMainWindowTargets(cdpPort).catch(() => []);
          const disposeExpr = `(() => { try { window.__AGAutoRenameOverlay?.dispose?.(); delete window.__AGAutoRenameOverlay; delete window.__AGAutoRenameBridge; return true; } catch { return false; } })()`;
          for (const t of targets) {
            await evaluateOnTarget(t.webSocketDebuggerUrl, disposeExpr).catch(() => {});
          }
        }
      } finally {
        stopped = prevStopped;
      }
    }
    stopped = true;
    hadInjectedTargets = false;
    if (server) {
      const srv = server;
      server = null;
      bridgePort = 0;
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  }

  function notifySettingChanged(enabled) {
    if (!enabled) hadInjectedTargets = true;
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  return {
    ensureBridgeServer,
    syncAllWindows,
    notifySettingChanged,
    start,
    stop,
    getBridgeInfo: () => ({ port: bridgePort, token: bridgeToken, running: Boolean(server) }),
  };
}
