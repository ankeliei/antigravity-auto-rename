/**
 * @fileoverview Injected Shadow DOM topbar shortcut capsule & quick popover
 * for Antigravity's main window (`window.__AGAutoRenameOverlay`).
 *
 * Mounts `#ag-auto-rename-capsule` cleanly inside `[class*="@container/titlebar"]`
 * and coexists with other extensions without modifying `app.asar`.
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const CAPSULE_ID = 'ag-auto-rename-capsule';
  const PORTAL_ID = 'ag-auto-rename-portal';

  try {
    window.__AGAutoRenameOverlay?.dispose?.();
    document.getElementById(CAPSULE_ID)?.remove?.();
    document.getElementById(PORTAL_ID)?.remove?.();
  } catch {
    // Ignore stale instance cleanup errors
  }

  const getBridge = () => window.__AGAutoRenameBridge || null;
  const brInit = getBridge();
  const bundleVersion = String(brInit?.bundleVersion || '');
  const stylesCss = String(brInit?.stylesCss || '');

  let disposed = false;
  let popoverOpen = false;
  let renaming = false;
  let latestStatus = brInit?.initialStatus || null;
  let toastTimer = null;

  function extractActiveRouteConversationId() {
    const m = String(window.location?.pathname || '').match(/^\/c\/([a-f0-9-]{36})(?:\/|$)/i);
    return m ? m[1] : '';
  }

  function detectThemeClass() {
    try {
      const htmlCls = document.documentElement?.className || '';
      if (/\bdark\b/i.test(htmlCls)) return 'ar-theme-dark';
      if (/\blight\b/i.test(htmlCls)) return 'ar-theme-light';
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) {
        const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
        return lum > 0.55 ? 'ar-theme-light' : 'ar-theme-dark';
      }
    } catch {
      // Fallback dark
    }
    return 'ar-theme-dark';
  }

  function deliverRpc(responses) {
    const br = getBridge();
    if (!br || !(br.rpcPending instanceof Map) || !Array.isArray(responses)) return 0;
    let delivered = 0;
    for (const item of responses) {
      const entry = br.rpcPending.get(item?.id);
      if (!entry) continue;
      br.rpcPending.delete(item.id);
      delivered += 1;
      if (item.ok) entry.resolve(item.data);
      else entry.reject(new Error(item.error || `HTTP ${item.status || 500}`));
    }
    return delivered;
  }

  function callViaCdp(br, path, method, body) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(br.rpcQueue)) br.rpcQueue = [];
      if (!(br.rpcPending instanceof Map)) br.rpcPending = new Map();
      const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        br.rpcPending.delete(id);
        reject(new Error('Bridge RPC timeout'));
      }, 20_000);
      br.rpcPending.set(id, {
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      br.rpcQueue.push({ id, path, method, body });
    });
  }

  async function callBridgeApi(path, { method = 'GET', body } = {}) {
    const br = getBridge();
    if (!br?.port || !br?.token) throw new Error('Bridge disconnected');
    if (br.transportMode === 'cdp') {
      return callViaCdp(br, path, method, body);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${br.port}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Auto-Rename-Token': br.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      if (err?.message && !/failed to fetch|networkerror|load failed/i.test(err.message)) {
        throw err;
      }
      br.transportMode = 'cdp';
      return callViaCdp(br, path, method, body);
    }
  }

  function markNoDrag(node) {
    if (!node?.style) return;
    node.style.setProperty('-webkit-app-region', 'no-drag', 'important');
    node.style.pointerEvents = 'auto';
  }

  // --- Capsule Shadow Host ---
  const capsuleHost = document.createElement('div');
  capsuleHost.id = CAPSULE_ID;
  capsuleHost.className = `ar-capsule-host ${detectThemeClass()}`;
  markNoDrag(capsuleHost);
  const capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });

  const capStyle = document.createElement('style');
  capStyle.textContent = stylesCss;
  capsuleShadow.appendChild(capStyle);

  const capGroup = document.createElement('div');
  capGroup.className = 'ar-cap-group';
  markNoDrag(capGroup);

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'ar-cap-btn';
  renameBtn.title = '使用自定义提示词立即重命名当前会话';
  renameBtn.textContent = '✨ 重命名';
  markNoDrag(renameBtn);

  const caretBtn = document.createElement('button');
  caretBtn.type = 'button';
  caretBtn.className = 'ar-cap-caret';
  caretBtn.title = '打开重命名选项与自动周期配置';
  caretBtn.textContent = '▾';
  markNoDrag(caretBtn);

  capGroup.appendChild(renameBtn);
  capGroup.appendChild(caretBtn);
  capsuleShadow.appendChild(capGroup);

  // --- Portal Shadow Host ---
  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_ID;
  portalHost.className = `ar-portal-host ${detectThemeClass()}`;
  const portalShadow = portalHost.attachShadow({ mode: 'open' });

  const portalStyle = document.createElement('style');
  portalStyle.textContent = stylesCss;
  portalShadow.appendChild(portalStyle);

  const toastEl = document.createElement('div');
  toastEl.className = 'ar-toast';
  toastEl.hidden = true;
  portalShadow.appendChild(toastEl);

  const popoverEl = document.createElement('div');
  popoverEl.className = 'ar-popover';
  popoverEl.hidden = true;
  markNoDrag(popoverEl);

  const popHeader = document.createElement('div');
  popHeader.className = 'ar-header';
  const popTitle = document.createElement('strong');
  popTitle.style.fontSize = '13px';
  popTitle.textContent = '会话快速重命名';
  const popMeta = document.createElement('span');
  popMeta.className = 'ar-badge';
  popMeta.textContent = 'Auto';
  popHeader.appendChild(popTitle);
  popHeader.appendChild(popMeta);

  const manualRow = document.createElement('div');
  manualRow.className = 'ar-input-row';
  const manualInput = document.createElement('input');
  manualInput.type = 'text';
  manualInput.className = 'ar-input';
  manualInput.placeholder = '输入手动标题…';
  const manualSaveBtn = document.createElement('button');
  manualSaveBtn.type = 'button';
  manualSaveBtn.className = 'ar-btn ar-btn-sm ar-btn-primary';
  manualSaveBtn.textContent = '保存';
  manualRow.appendChild(manualInput);
  manualRow.appendChild(manualSaveBtn);

  const intervalField = document.createElement('div');
  intervalField.className = 'ar-field';
  const intervalLabel = document.createElement('label');
  intervalLabel.textContent = '每隔几次用户发言自动重命名 (0=仅首次)';
  const intervalRow = document.createElement('div');
  intervalRow.className = 'ar-input-row';
  const intervalInput = document.createElement('input');
  intervalInput.type = 'number';
  intervalInput.min = '0';
  intervalInput.max = '100';
  intervalInput.className = 'ar-input';
  const intervalSaveBtn = document.createElement('button');
  intervalSaveBtn.type = 'button';
  intervalSaveBtn.className = 'ar-btn ar-btn-sm';
  intervalSaveBtn.textContent = '应用';
  intervalRow.appendChild(intervalInput);
  intervalRow.appendChild(intervalSaveBtn);
  intervalField.appendChild(intervalLabel);
  intervalField.appendChild(intervalRow);

  const promptField = document.createElement('div');
  promptField.className = 'ar-field';
  const promptLabel = document.createElement('label');
  promptLabel.textContent = '自定义命名提示词';
  const promptTextarea = document.createElement('textarea');
  promptTextarea.className = 'ar-textarea';
  promptTextarea.style.minHeight = '62px';
  promptField.appendChild(promptLabel);
  promptField.appendChild(promptTextarea);

  const actionRow = document.createElement('div');
  actionRow.className = 'ar-btn-row';
  const aiRenamePopBtn = document.createElement('button');
  aiRenamePopBtn.type = 'button';
  aiRenamePopBtn.className = 'ar-btn ar-btn-sm ar-btn-primary';
  aiRenamePopBtn.textContent = '✨ AI 重命名';
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'ar-btn ar-btn-sm';
  undoBtn.textContent = '↩ 恢复原名';
  const saveRuleBtn = document.createElement('button');
  saveRuleBtn.type = 'button';
  saveRuleBtn.className = 'ar-btn ar-btn-sm';
  saveRuleBtn.textContent = '保存提示词';
  actionRow.appendChild(aiRenamePopBtn);
  actionRow.appendChild(undoBtn);
  actionRow.appendChild(saveRuleBtn);

  popoverEl.appendChild(popHeader);
  popoverEl.appendChild(manualRow);
  popoverEl.appendChild(intervalField);
  popoverEl.appendChild(promptField);
  popoverEl.appendChild(actionRow);
  portalShadow.appendChild(popoverEl);

  function showToast(msg, duration = 3400) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, duration);
  }

  function syncThemeClasses() {
    const cls = detectThemeClass();
    capsuleHost.className = `ar-capsule-host ${cls}`;
    portalHost.className = `ar-portal-host ${cls}`;
  }

  function syncPopoverFields(status) {
    if (!status) return;
    latestStatus = status;
    const conv = status.activeConversation;
    const s = status.settings || {};
    popMeta.textContent = conv
      ? `${conv.initiationLanguage?.label || 'Auto'} · ${conv.userTurnCount || 0}轮`
      : '就绪';
    if (document.activeElement !== manualInput) {
      manualInput.value = conv?.title || '';
    }
    if (document.activeElement !== intervalInput) {
      intervalInput.value = String(s.autoRenameInterval ?? 5);
    }
    if (document.activeElement !== promptTextarea) {
      promptTextarea.value = s.customPromptRules || '';
    }
    undoBtn.hidden = !conv?.canUndo;
  }

  async function refreshStatus() {
    const routeId = extractActiveRouteConversationId();
    const q = routeId ? `?conversationId=${encodeURIComponent(routeId)}` : '';
    const data = await callBridgeApi(`/api/status${q}`);
    syncPopoverFields(data);
    return data;
  }

  function positionPopover() {
    const rect = capsuleHost.getBoundingClientRect();
    const top = Math.max(36, Math.round(rect.bottom + 6));
    const left = Math.max(12, Math.min(window.innerWidth - 352, Math.round(rect.right - 340)));
    popoverEl.style.top = `${top}px`;
    popoverEl.style.left = `${left}px`;
  }

  function setPopoverOpen(next) {
    popoverOpen = Boolean(next);
    popoverEl.hidden = !popoverOpen;
    if (popoverOpen) {
      syncThemeClasses();
      positionPopover();
      void refreshStatus().catch(() => {});
    }
  }

  async function triggerAiRename() {
    if (renaming) return;
    renaming = true;
    renameBtn.disabled = true;
    aiRenamePopBtn.disabled = true;
    const orig = renameBtn.textContent;
    renameBtn.textContent = '✨ 命名中…';
    try {
      const routeId = extractActiveRouteConversationId();
      const out = await callBridgeApi('/api/rename', {
        method: 'POST',
        body: { cascadeId: routeId },
      });
      showToast(`已重命名为：「${out.title}」`);
      await refreshStatus().catch(() => {});
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 4200);
    } finally {
      renaming = false;
      renameBtn.disabled = false;
      aiRenamePopBtn.disabled = false;
      renameBtn.textContent = orig;
    }
  }

  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void triggerAiRename();
  });

  caretBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopoverOpen(!popoverOpen);
  });

  aiRenamePopBtn.addEventListener('click', () => {
    void triggerAiRename();
  });

  manualSaveBtn.addEventListener('click', async () => {
    const val = manualInput.value.trim();
    if (!val) return;
    try {
      const routeId = extractActiveRouteConversationId() || latestStatus?.activeConversation?.cascadeId || '';
      const out = await callBridgeApi('/api/rename', {
        method: 'POST',
        body: { cascadeId: routeId, customTitle: val },
      });
      showToast(`已更新标题：「${out.title}」`);
      await refreshStatus().catch(() => {});
    } catch (err) {
      showToast(`保存失败：${err.message}`, 4000);
    }
  });

  undoBtn.addEventListener('click', async () => {
    try {
      const routeId = extractActiveRouteConversationId() || latestStatus?.activeConversation?.cascadeId || '';
      const out = await callBridgeApi('/api/undo-rename', {
        method: 'POST',
        body: { cascadeId: routeId },
      });
      showToast(`已恢复标题：「${out.title}」`);
      await refreshStatus().catch(() => {});
    } catch (err) {
      showToast(`恢复失败：${err.message}`, 4000);
    }
  });

  const saveQuickSettings = async (patch, successMsg) => {
    try {
      await callBridgeApi('/api/settings', { method: 'POST', body: patch });
      showToast(successMsg);
      await refreshStatus().catch(() => {});
    } catch (err) {
      showToast(`保存失败：${err.message}`, 4000);
    }
  };

  intervalSaveBtn.addEventListener('click', () => {
    const raw = intervalInput.value.trim();
    if (raw === '' || !Number.isFinite(Number(raw))) {
      showToast('请输入有效的触发轮数（0 或正整数）', 3000);
      return;
    }
    const nextVal = Math.max(0, Math.min(100, Math.floor(Number(raw))));
    intervalInput.value = String(nextVal);
    void saveQuickSettings(
      { autoRenameInterval: nextVal },
      nextVal === 0
        ? '已更新周期：仅首次提问时命名'
        : `已更新自动重命名周期：每 ${nextVal} 轮`
    );
  });

  saveRuleBtn.addEventListener('click', () => {
    void saveQuickSettings(
      { customPromptRules: promptTextarea.value },
      '自定义命名提示词已保存'
    );
  });

  function findHostTitlebar() {
    return document.querySelector('[class*="@container/titlebar"]');
  }

  function ensureAlive() {
    if (disposed) return false;
    const bodyOrDoc = document.body || document.documentElement;
    if (bodyOrDoc && !portalHost.isConnected) {
      bodyOrDoc.appendChild(portalHost);
    }
    const titlebar = findHostTitlebar();
    if (titlebar) {
      const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild || titlebar;
      if (capsuleHost.parentElement !== rightGroup) {
        if (rightGroup !== titlebar && rightGroup.firstChild) {
          rightGroup.insertBefore(capsuleHost, rightGroup.firstChild);
        } else {
          rightGroup.appendChild(capsuleHost);
        }
      }
      capsuleHost.style.position = 'relative';
      capsuleHost.style.top = '';
      capsuleHost.style.right = '';
    } else if (bodyOrDoc && !capsuleHost.isConnected) {
      capsuleHost.style.position = 'fixed';
      capsuleHost.style.top = '8px';
      capsuleHost.style.right = '140px';
      bodyOrDoc.appendChild(capsuleHost);
    }
    syncThemeClasses();
    markNoDrag(capsuleHost);
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  const onDocMouseDown = (e) => {
    if (!popoverOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(popoverEl) && !path.includes(capsuleHost)) {
      setPopoverOpen(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && popoverOpen) setPopoverOpen(false);
  };

  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKeyDown);

  let observer = null;
  if (typeof MutationObserver !== 'undefined' && document.body) {
    observer = new MutationObserver(() => {
      if (!capsuleHost.isConnected || !portalHost.isConnected) {
        ensureAlive();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  ensureAlive();
  if (latestStatus) syncPopoverFields(latestStatus);

  window.__AGAutoRenameOverlay = {
    bundleVersion,
    ensureAlive,
    updateBridge({ port, token }) {
      const br = getBridge();
      if (br) {
        br.port = port;
        br.token = token;
      }
    },
    deliverRpc,
    dispose() {
      disposed = true;
      if (toastTimer) clearTimeout(toastTimer);
      observer?.disconnect();
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
      capsuleHost.remove();
      portalHost.remove();
      if (window.__AGAutoRenameOverlay) {
        delete window.__AGAutoRenameOverlay;
      }
    },
  };
})();
