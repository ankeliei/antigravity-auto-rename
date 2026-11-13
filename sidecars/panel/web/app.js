(function () {
  const fetchFn = window.sidecar?.fetch
    ? window.sidecar.fetch.bind(window.sidecar)
    : window.fetch.bind(window);

  const el = (id) => document.getElementById(id);

  let currentStatus = null;
  let selectedConversationId = window.sidecar?.conversationId || '';
  let bannerTimer = null;

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetchFn(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function showBanner(msg, type = 'ok') {
    const box = el('status-banner');
    box.textContent = msg;
    box.className = `ar-status-banner show ${type === 'err' ? 'err' : 'ok'}`;
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      box.className = 'ar-status-banner';
    }, 4500);
  }

  function formatRelativeTime(ms) {
    if (!ms) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    return `${Math.floor(diffSec / 86400)} 天前`;
  }

  function readDraftSettings() {
    return {
      enabled: el('cfg-enabled').checked,
      hookFirstTurn: el('cfg-hook-first').checked,
      preferInitiationLanguage: el('cfg-prefer-lang').checked,
      keepTechTerms: el('cfg-keep-tech').checked,
      addWorkspacePrefix: el('cfg-ws-prefix').checked,
      addEmojiPrefix: el('cfg-emoji-prefix').checked,
      enableWindowOverlay: el('cfg-window-overlay').checked,
      autoRenameInterval: Number(el('cfg-interval').value || 0),
      contextRecentTurns: Number(el('cfg-recent-turns').value || 5),
      triggerTiming: el('cfg-timing').value === 'stop' ? 'stop' : 'pre',
      maxTitleCharsZh: Number(el('cfg-max-zh').value || 14),
      customPromptRules: el('cfg-custom-rules').value,
    };
  }

  function populateSettingsForm(settings) {
    if (!settings) return;
    el('cfg-enabled').checked = settings.enabled !== false;
    el('cfg-hook-first').checked = settings.hookFirstTurn !== false;
    el('cfg-prefer-lang').checked = settings.preferInitiationLanguage !== false;
    el('cfg-keep-tech').checked = settings.keepTechTerms !== false;
    el('cfg-ws-prefix').checked = Boolean(settings.addWorkspacePrefix);
    el('cfg-emoji-prefix').checked = Boolean(settings.addEmojiPrefix);
    el('cfg-window-overlay').checked = settings.enableWindowOverlay !== false;
    el('cfg-interval').value = String(settings.autoRenameInterval ?? 5);
    el('cfg-recent-turns').value = String(settings.contextRecentTurns ?? 5);
    el('cfg-timing').value = settings.triggerTiming === 'stop' ? 'stop' : 'pre';
    el('cfg-max-zh').value = String(settings.maxTitleCharsZh ?? 14);
    el('cfg-custom-rules').value = settings.customPromptRules || '';
  }

  function renderActiveConversation(status) {
    const active = status?.activeConversation;
    const titleEl = el('active-title');
    const metaEl = el('active-meta');
    const undoBtn = el('undo-active-btn');
    const manualInput = el('manual-title-input');

    metaEl.textContent = '';
    if (!active) {
      titleEl.textContent = '未检测到活跃会话';
      undoBtn.hidden = true;
      return;
    }

    titleEl.textContent = active.title || 'Untitled Conversation';
    if (document.activeElement !== manualInput && !manualInput.dataset.dirty) {
      manualInput.value = active.title || '';
    }

    const addPill = (text, cls = 'ar-badge') => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      metaEl.appendChild(span);
    };

    const langLabel = active.initiationLanguage?.label || '未知';
    addPill(`发起语言: ${langLabel}`);
    addPill(`用户发言: ${active.userTurnCount || 0} 轮`);
    if (active.turnsUntilAutoRename !== null && active.turnsUntilAutoRename !== undefined) {
      addPill(
        active.turnsUntilAutoRename === 0
          ? '本轮可触发自动重命名'
          : `再发 ${active.turnsUntilAutoRename} 次自动重命名`,
        'ar-badge warn'
      );
    }

    undoBtn.hidden = !active.canUndo;
  }

  function renderConversationsList(status) {
    const listEl = el('conv-list');
    listEl.textContent = '';
    const items = Array.isArray(status?.recentConversations) ? status.recentConversations : [];
    const activeId = status?.activeConversation?.cascadeId || '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ar-hint';
      empty.textContent = '暂无本地会话记录';
      listEl.appendChild(empty);
      return;
    }

    for (const conv of items.slice(0, 12)) {
      const row = document.createElement('div');
      row.className = `ar-conv-item${conv.cascadeId === activeId ? ' is-active' : ''}`;

      const main = document.createElement('div');
      main.className = 'ar-conv-main';

      const t = document.createElement('div');
      t.className = 'ar-conv-title';
      t.textContent = conv.title || 'Untitled Conversation';
      t.title = `${conv.title}\nID: ${conv.cascadeId}`;

      const sub = document.createElement('div');
      sub.className = 'ar-conv-sub';
      const rel = formatRelativeTime(conv.lastModifiedMs);
      const lang = conv.initiationLanguage?.label || '未知';
      sub.textContent = `${lang} · ${conv.userTurnCount || 0} 轮发言${rel ? ` · ${rel}` : ''}`;

      main.appendChild(t);
      main.appendChild(sub);

      const btnWrap = document.createElement('div');
      btnWrap.className = 'ar-btn-row';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'ar-btn ar-btn-sm';
      renameBtn.textContent = '✨ 重命名';
      renameBtn.addEventListener('click', async () => {
        renameBtn.disabled = true;
        renameBtn.textContent = '生成中…';
        try {
          selectedConversationId = conv.cascadeId;
          const out = await api('/api/rename', { method: 'POST', body: { cascadeId: conv.cascadeId } });
          showBanner(`已重命名：${out.title}`);
          await refreshStatus({ populateForm: false });
        } catch (err) {
          showBanner(`重命名失败：${err.message}`, 'err');
        } finally {
          renameBtn.disabled = false;
          renameBtn.textContent = '✨ 重命名';
        }
      });

      btnWrap.appendChild(renameBtn);
      row.appendChild(main);
      row.appendChild(btnWrap);
      listEl.appendChild(row);
    }
  }

  async function refreshStatus({ populateForm = true } = {}) {
    try {
      const q = selectedConversationId
        ? `?conversationId=${encodeURIComponent(selectedConversationId)}`
        : '';
      const data = await api(`/api/status${q}`);
      currentStatus = data;

      const badge = el('conn-badge');
      badge.textContent = data.lsConnected ? '已连接 LS' : 'LS 未连接';
      badge.className = `ar-badge ${data.lsConnected ? 'ok' : 'warn'}`;

      if (populateForm) {
        populateSettingsForm(data.settings);
      }
      renderActiveConversation(data);
      renderConversationsList(data);
    } catch (err) {
      const badge = el('conn-badge');
      badge.textContent = '读取失败';
      badge.className = 'ar-badge warn';
      showBanner(`状态刷新失败：${err.message}`, 'err');
    }
  }

  el('manual-title-input').addEventListener('input', (ev) => {
    ev.target.dataset.dirty = '1';
  });

  el('refresh-btn').addEventListener('click', () => {
    void refreshStatus({ populateForm: true });
  });

  el('rename-active-btn').addEventListener('click', async () => {
    const btn = el('rename-active-btn');
    const targetId = currentStatus?.activeConversation?.cascadeId || selectedConversationId;
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = '正在生成并重命名…';
    try {
      const out = await api('/api/rename', {
        method: 'POST',
        body: { cascadeId: targetId },
      });
      delete el('manual-title-input').dataset.dirty;
      showBanner(`已重命名为：「${out.title}」`);
      await refreshStatus({ populateForm: false });
    } catch (err) {
      showBanner(`重命名失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  });

  el('undo-active-btn').addEventListener('click', async () => {
    const targetId = currentStatus?.activeConversation?.cascadeId || selectedConversationId;
    if (!targetId) return;
    try {
      const out = await api('/api/undo-rename', { method: 'POST', body: { cascadeId: targetId } });
      delete el('manual-title-input').dataset.dirty;
      showBanner(`已恢复标题：「${out.title}」`);
      await refreshStatus({ populateForm: false });
    } catch (err) {
      showBanner(`恢复失败：${err.message}`, 'err');
    }
  });

  el('manual-title-save').addEventListener('click', async () => {
    const targetId = currentStatus?.activeConversation?.cascadeId || selectedConversationId;
    const val = el('manual-title-input').value.trim();
    if (!targetId || !val) {
      showBanner('请输入有效的会话标题', 'err');
      return;
    }
    try {
      const out = await api('/api/rename', {
        method: 'POST',
        body: { cascadeId: targetId, customTitle: val },
      });
      delete el('manual-title-input').dataset.dirty;
      showBanner(`已更新标题：「${out.title}」`);
      await refreshStatus({ populateForm: false });
    } catch (err) {
      showBanner(`保存失败：${err.message}`, 'err');
    }
  });

  el('save-settings-btn').addEventListener('click', async () => {
    const btn = el('save-settings-btn');
    btn.disabled = true;
    try {
      const draft = readDraftSettings();
      const out = await api('/api/settings', { method: 'POST', body: draft });
      populateSettingsForm(out.settings);
      showBanner('配置已保存并立即生效');
      await refreshStatus({ populateForm: false });
    } catch (err) {
      showBanner(`保存失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  el('preview-prompt-btn').addEventListener('click', async () => {
    const box = el('prompt-preview-box');
    if (!box.hidden && box.dataset.loaded === '1') {
      box.hidden = true;
      return;
    }
    try {
      const targetId = currentStatus?.activeConversation?.cascadeId || selectedConversationId;
      const out = await api('/api/preview-prompt', {
        method: 'POST',
        body: { cascadeId: targetId, settings: readDraftSettings() },
      });
      box.textContent = out.prompt || '';
      box.dataset.loaded = '1';
      box.hidden = false;
    } catch (err) {
      showBanner(`预览失败：${err.message}`, 'err');
    }
  });

  void refreshStatus({ populateForm: true });
})();
