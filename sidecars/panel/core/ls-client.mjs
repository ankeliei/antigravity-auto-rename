/**
 * @fileoverview Cross-platform Antigravity Language Server Connect RPC client,
 * process discovery, model resolution, and transcript loader.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  LS_CACHE_FILE,
  loadJson,
  resolveBrainDir,
  saveJsonAtomic,
} from './config.mjs';

const execFileAsync = promisify(execFile);

let cachedEndpoint = null;

/**
 * Normalizes a Language Server address string into a base URL.
 *
 * @param {string} rawAddress
 * @returns {string}
 */
export function normalizeLsBaseUrl(rawAddress) {
  const trimmed = String(rawAddress || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function getEndpointFromEnv(env = process.env) {
  const rawAddr = String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrfToken = String(env?.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!rawAddr || rawAddr === 'test.invalid') return null;
  const baseUrl = normalizeLsBaseUrl(rawAddr);
  if (!baseUrl) return null;
  return { baseUrl, csrfToken, source: 'env' };
}

function postJsonViaNodeHttp(urlStr, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(bodyObj ?? {});
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
            reject(new Error(`RPC HTTP ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(text.trim() ? JSON.parse(text) : {});
          } catch (err) {
            reject(new Error(`Invalid JSON from RPC: ${err.message}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`RPC timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function probeEndpoint(baseUrl, csrfToken, timeoutMs = 1500) {
  try {
    await postJsonViaNodeHttp(
      `${baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
      { 'x-codeium-csrf-token': csrfToken || '' },
      {},
      timeoutMs
    );
    return true;
  } catch {
    return false;
  }
}

async function discoverUnixEndpoints() {
  const results = [];
  let psOut = '';
  try {
    const res = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { timeout: 2500 });
    psOut = res.stdout || '';
  } catch {
    return results;
  }

  for (const line of psOut.split(/\r?\n/)) {
    if (!line.includes('language_server') || !line.includes('--csrf_token')) continue;
    const trimmed = line.trim();
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx <= 0) continue;
    const pid = trimmed.slice(0, spaceIdx).trim();
    const cmd = trimmed.slice(spaceIdx + 1);
    const tokenMatch = cmd.match(/--csrf_token(?:\s+|=)([^\s]+)/);
    const csrfToken = tokenMatch ? tokenMatch[1].replace(/^['"]|['"]$/g, '') : '';
    if (!pid || !csrfToken) continue;

    const ports = new Set();
    try {
      const lsofRes = await execFileAsync(
        'lsof',
        ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid],
        { timeout: 2500 }
      );
      for (const lLine of (lsofRes.stdout || '').split(/\r?\n/)) {
        const m = lLine.match(/(?:127\.0\.0\.1|localhost|\[::1\]|\*):(\d+)\s+\(LISTEN\)/);
        if (m) ports.add(Number(m[1]));
      }
    } catch {
      // Fallback to ss on minimal Linux environments without lsof
      try {
        const ssRes = await execFileAsync('ss', ['-tlnp'], { timeout: 2500 });
        for (const sLine of (ssRes.stdout || '').split(/\r?\n/)) {
          if (!sLine.includes(`pid=${pid},`) && !sLine.includes(`pid=${pid})`)) continue;
          const m = sLine.match(/(?:127\.0\.0\.1|\[::1\]|\*):(\d+)/);
          if (m) ports.add(Number(m[1]));
        }
      } catch {
        // Ignore if neither lsof nor ss is installed
      }
    }

    for (const port of ports) {
      results.push({ baseUrl: `http://127.0.0.1:${port}`, csrfToken, pid: Number(pid) });
      results.push({ baseUrl: `https://127.0.0.1:${port}`, csrfToken, pid: Number(pid) });
    }
  }
  return results;
}

async function discoverWindowsEndpoints() {
  const results = [];
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' -and $_.CommandLine -like '*--csrf_token*' }",
    '$out = foreach ($p in $procs) {',
    "  $ports = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen | Select-Object -ExpandProperty LocalPort -Unique)",
    '  [PSCustomObject]@{ pid = $p.ProcessId; cmd = $p.CommandLine; ports = $ports }',
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('; ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 4000 }
    );
    const raw = (stdout || '').trim();
    if (!raw) return results;
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      const cmd = String(row?.cmd || '');
      const m = cmd.match(/--csrf_token(?:\s+|=)([^\s]+)/);
      const csrfToken = m ? m[1].replace(/^['"]|['"]$/g, '') : '';
      if (!csrfToken) continue;
      for (const port of row?.ports || []) {
        const pNum = Number(port);
        if (Number.isInteger(pNum) && pNum > 0) {
          results.push({ baseUrl: `http://127.0.0.1:${pNum}`, csrfToken, pid: Number(row.pid || 0) });
          results.push({ baseUrl: `https://127.0.0.1:${pNum}`, csrfToken, pid: Number(row.pid || 0) });
        }
      }
    }
  } catch {
    // PowerShell unavailable or blocked
  }
  return results;
}

/**
 * Discovers the active Antigravity Language Server Connect RPC endpoint and CSRF token.
 * Order: environment variables -> verified disk/memory cache -> cross-platform process scan.
 *
 * @param {{ env?: Record<string, string|undefined>, cacheFile?: string, forceScan?: boolean, platform?: string }} [options]
 * @returns {Promise<{ baseUrl: string, csrfToken: string, source: string } | null>}
 */
export async function discoverLanguageServer(options = {}) {
  const {
    env = process.env,
    cacheFile = LS_CACHE_FILE,
    forceScan = false,
    platform = process.platform,
  } = options;

  const envEndpoint = getEndpointFromEnv(env);
  if (envEndpoint && !forceScan) {
    cachedEndpoint = envEndpoint;
    return envEndpoint;
  }

  if (!forceScan && cachedEndpoint && (Date.now() - (cachedEndpoint.checkedAtMs || 0)) < 30_000) {
    return cachedEndpoint;
  }

  if (!forceScan) {
    const diskCache = loadJson(cacheFile, null);
    if (diskCache?.baseUrl && diskCache?.csrfToken) {
      if (await probeEndpoint(diskCache.baseUrl, diskCache.csrfToken, 1000)) {
        cachedEndpoint = {
          baseUrl: diskCache.baseUrl,
          csrfToken: diskCache.csrfToken,
          source: 'cache',
          checkedAtMs: Date.now(),
        };
        return cachedEndpoint;
      }
    }
  }

  const candidates = platform === 'win32'
    ? await discoverWindowsEndpoints()
    : await discoverUnixEndpoints();

  for (const cand of candidates) {
    if (await probeEndpoint(cand.baseUrl, cand.csrfToken, 1200)) {
      cachedEndpoint = {
        baseUrl: cand.baseUrl,
        csrfToken: cand.csrfToken,
        source: 'scan',
        checkedAtMs: Date.now(),
      };
      saveJsonAtomic(cacheFile, {
        baseUrl: cand.baseUrl,
        csrfToken: cand.csrfToken,
        pid: cand.pid || 0,
        updatedAtMs: Date.now(),
      });
      return cachedEndpoint;
    }
  }

  return envEndpoint;
}

/**
 * Calls a LanguageServerService Connect JSON RPC method with automatic endpoint discovery & retry.
 *
 * @param {string} method
 * @param {object} [body={}]
 * @param {{ timeoutMs?: number, env?: Record<string, string|undefined>, cacheFile?: string, endpoint?: { baseUrl: string, csrfToken: string } }} [options]
 * @returns {Promise<object>}
 */
export async function callLsRpc(method, body = {}, options = {}) {
  const { timeoutMs = 8000, env = process.env, cacheFile = LS_CACHE_FILE, endpoint: explicitEndpoint } = options;
  let ep = explicitEndpoint || (await discoverLanguageServer({ env, cacheFile }));
  if (!ep?.baseUrl) {
    throw new Error('无法发现运行中的 Antigravity Language Server 进程');
  }

  const invoke = (target) =>
    postJsonViaNodeHttp(
      `${target.baseUrl}/exa.language_server_pb.LanguageServerService/${method}`,
      { 'x-codeium-csrf-token': target.csrfToken || '' },
      body,
      timeoutMs
    );

  try {
    return await invoke(ep);
  } catch (err) {
    // If cached/stale port stopped listening, perform one fresh process scan
    if (!explicitEndpoint && /ECONNREFUSED|ECONNRESET|timeout/i.test(err?.message || '')) {
      cachedEndpoint = null;
      const freshEp = await discoverLanguageServer({ env, cacheFile, forceScan: true });
      if (freshEp && freshEp.baseUrl !== ep.baseUrl) {
        return invoke(freshEp);
      }
    }
    throw err;
  }
}

/**
 * Updates `annotations.title` for a conversation and triggers reactive UI updates.
 *
 * @param {string} cascadeId
 * @param {string} title
 * @param {object} [rpcOptions]
 */
export async function updateConversationTitle(cascadeId, title, rpcOptions = {}) {
  if (!cascadeId) throw new Error('cascadeId is required');
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('title must be non-empty');
  return callLsRpc(
    'UpdateConversationAnnotations',
    {
      cascadeId,
      annotations: {
        title: cleanTitle,
      },
      mergeAnnotations: true,
    },
    rpcOptions
  );
}

/**
 * Generates a short text response using Antigravity's built-in LanguageServer model API.
 * Falls back cleanly across utility models if the configured model enum is rejected.
 *
 * @param {string} prompt
 * @param {number} [modelEnum=1050]
 * @param {object} [rpcOptions]
 * @returns {Promise<{ text: string, modelUsed: number }>}
 */
export async function generateWithUtilityModel(prompt, modelEnum = 1050, rpcOptions = {}) {
  const candidates = [];
  const addCandidate = (val) => {
    const num = Number(val);
    if (Number.isInteger(num) && num >= 0 && !candidates.includes(num)) {
      candidates.push(num);
    }
  };
  addCandidate(modelEnum);
  addCandidate(1050); // MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE

  let lastErr = null;
  for (const candModel of candidates) {
    try {
      const res = await callLsRpc(
        'GetModelResponse',
        { prompt, model: candModel },
        { timeoutMs: 20_000, ...rpcOptions }
      );
      const text = String(res?.response || '').trim();
      if (text) {
        return { text, modelUsed: candModel };
      }
    } catch (err) {
      lastErr = err;
    }
  }

  // Fallback: inspect configured models from GetCascadeModelConfigs
  try {
    const cfgRes = await callLsRpc('GetCascadeModelConfigs', {}, rpcOptions);
    const configs = Array.isArray(cfgRes?.clientModelConfigs) ? cfgRes.clientModelConfigs : [];
    for (const cfg of configs) {
      const modelOrAlias = cfg?.modelOrAlias?.model;
      const enumNum = Number(modelOrAlias);
      if (Number.isInteger(enumNum) && enumNum > 0 && !candidates.includes(enumNum)) {
        try {
          const res = await callLsRpc(
            'GetModelResponse',
            { prompt, model: enumNum },
            { timeoutMs: 20_000, ...rpcOptions }
          );
          const text = String(res?.response || '').trim();
          if (text) {
            return { text, modelUsed: enumNum };
          }
        } catch (err) {
          lastErr = err;
        }
      }
    }
  } catch (err) {
    lastErr = lastErr || err;
  }

  throw lastErr || new Error('GetModelResponse returned empty response');
}

/**
 * Lists all Antigravity conversations ordered by most recently modified.
 *
 * @param {object} [rpcOptions]
 */
export async function listConversations(rpcOptions = {}) {
  const res = await callLsRpc('GetAllCascadeTrajectories', {}, rpcOptions);
  const map = res?.trajectorySummaries || {};
  const list = Object.entries(map).map(([cascadeId, info]) => {
    const annotationTitle = String(info?.annotations?.title || '').trim();
    const summaryTitle = String(info?.summary || '').trim();
    const lastModifiedTime = String(info?.lastModifiedTime || '');
    const lastModifiedMs = lastModifiedTime ? Date.parse(lastModifiedTime) || 0 : 0;
    const workspaces = Array.isArray(info?.workspaces) ? info.workspaces : [];
    return {
      cascadeId,
      summary: summaryTitle,
      annotationTitle,
      effectiveTitle: annotationTitle || summaryTitle || 'Untitled Conversation',
      stepCount: Number(info?.stepCount || 0),
      status: String(info?.status || ''),
      lastModifiedTime,
      lastModifiedMs,
      workspaces,
    };
  });
  list.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  return list;
}

/**
 * Reads user and planner turns from a local `transcript.jsonl` file.
 *
 * @param {string} transcriptPath
 * @returns {{ userMessages: string[], assistantMessages: string[] } | null}
 */
export function readTranscriptMessages(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const userMessages = [];
    const assistantMessages = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry?.type === 'USER_INPUT' && typeof entry.content === 'string') {
        userMessages.push(entry.content);
      } else if (entry?.type === 'PLANNER_RESPONSE' && typeof entry.content === 'string') {
        assistantMessages.push(entry.content);
      }
    }
    return { userMessages, assistantMessages };
  } catch {
    return null;
  }
}

/**
 * Resolves the default `transcript.jsonl` path for a conversation ID.
 *
 * @param {string} cascadeId
 * @param {string} [brainDir]
 * @returns {string}
 */
export function getDefaultTranscriptPath(cascadeId, brainDir = resolveBrainDir()) {
  if (!cascadeId) return '';
  return join(brainDir, cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
}

function extractTextFromRpcUserStep(step) {
  const ui = step?.userInput;
  if (!ui) return '';
  if (typeof ui.userResponse === 'string' && ui.userResponse.trim()) {
    return ui.userResponse;
  }
  if (Array.isArray(ui.items)) {
    const joined = ui.items
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined;
  }
  return '';
}

function extractTextFromRpcPlannerStep(step) {
  const pr = step?.plannerResponse;
  if (!pr) return '';
  return String(pr.modifiedResponse || pr.response || '');
}

/**
 * Fetches user and assistant messages for a conversation, preferring local `transcript.jsonl`
 * and falling back to `GetCascadeTrajectory` RPC.
 *
 * @param {string} cascadeId
 * @param {{ transcriptPath?: string, brainDir?: string, rpcOptions?: object }} [options]
 * @returns {Promise<{ userMessages: string[], assistantMessages: string[], source: string }>}
 */
export async function getConversationMessages(cascadeId, options = {}) {
  const { transcriptPath, brainDir = resolveBrainDir(), rpcOptions = {} } = options;
  const candidatePaths = [];
  if (transcriptPath) candidatePaths.push(transcriptPath);
  const defaultPath = getDefaultTranscriptPath(cascadeId, brainDir);
  if (defaultPath && defaultPath !== transcriptPath) candidatePaths.push(defaultPath);

  for (const filePath of candidatePaths) {
    const parsed = readTranscriptMessages(filePath);
    if (parsed && parsed.userMessages.length > 0) {
      return { ...parsed, source: 'transcript' };
    }
  }

  try {
    const trajRes = await callLsRpc('GetCascadeTrajectory', { cascadeId }, rpcOptions);
    const steps = Array.isArray(trajRes?.trajectory?.steps) ? trajRes.trajectory.steps : [];
    const userMessages = [];
    const assistantMessages = [];
    for (const step of steps) {
      if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT' || step?.userInput) {
        const text = extractTextFromRpcUserStep(step);
        if (text) userMessages.push(text);
      } else if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.plannerResponse) {
        const text = extractTextFromRpcPlannerStep(step);
        if (text) assistantMessages.push(text);
      }
    }
    return { userMessages, assistantMessages, source: 'rpc' };
  } catch {
    return { userMessages: [], assistantMessages: [], source: 'none' };
  }
}
