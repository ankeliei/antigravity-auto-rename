import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../sidecars/panel/core/config.mjs';
import {
  buildQuickFallbackTitle,
  buildRenamePrompt,
  cleanUserMessageText,
  detectInitiationLanguage,
  extractConversationContext,
  postprocessGeneratedTitle,
} from '../sidecars/panel/core/prompt-builder.mjs';
import {
  executeConversationRename,
  shouldTriggerAutoRename,
  undoConversationRename,
} from '../sidecars/panel/core/rename-engine.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(TEST_DIR);

function makeTempSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ag-auto-rename-test-'));
  return {
    dir,
    configFile: join(dir, 'config.json'),
    stateFile: join(dir, 'state.json'),
    brainDir: join(dir, 'brain'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('cleanUserMessageText strips XML wrappers, metadata, and leading slash commands', () => {
  const raw = `<USER_REQUEST>
/plan 我想开发一个 Antigravity 插件
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-11-14
</ADDITIONAL_METADATA>`;
  assert.equal(cleanUserMessageText(raw), '我想开发一个 Antigravity 插件');
});

test('detectInitiationLanguage prioritizes Chinese even with code blocks and English identifiers', () => {
  const mixed = `帮我看下这个函数为什么报错：
\`\`\`js
function computeLatencyMs(req) { return req.timeout + 100; }
\`\`\`
请查看 https://example.com/docs/api-v2 和 /Users/dev/project/main.mjs`;
  assert.equal(detectInitiationLanguage(mixed).code, 'zh');

  const pureEn = 'Please refactor the connect RPC retry handler in sidecars/panel/core/ls-client.mjs';
  assert.equal(detectInitiationLanguage(pureEn).code, 'en');

  const ja = '会話タイトルの自動生成ロジックを日本語に対応させてください';
  assert.equal(detectInitiationLanguage(ja).code, 'ja');
});

test('buildQuickFallbackTitle and postprocessGeneratedTitle produce clean titles', () => {
  const zhTitle = buildQuickFallbackTitle('/plan 请帮我开发一个自动重命名会话的插件，支持每5轮重命名');
  assert.ok(zhTitle.length > 0 && zhTitle.length <= DEFAULT_SETTINGS.maxTitleCharsZh);
  assert.ok(!zhTitle.includes('/plan'));

  const post = postprocessGeneratedTitle('### 标题：「会话自动重命名插件架构设计。」', '回退标题');
  assert.equal(post, '会话自动重命名插件架构设计');
});

test('extractConversationContext preserves turn 1 language and appends recent turns', async () => {
  const sb = makeTempSandbox();
  try {
    const cid = 'conv-1111';
    const logDir = join(sb.brainDir, cid, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\n帮我优化会话自动重命名插件\n</USER_REQUEST>' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: '好的，我们来看看具体结构。' }),
      JSON.stringify({ type: 'USER_INPUT', content: 'Fix TypeScript error in window-bridge.mjs' }),
      JSON.stringify({ type: 'USER_INPUT', content: 'Also check CSS styles for light theme' }),
    ].join('\n') + '\n';
    const tPath = join(logDir, 'transcript.jsonl');
    writeFileSync(tPath, lines, 'utf8');

    const ctx = await extractConversationContext({
      cascadeId: cid,
      transcriptPath: tPath,
      lastUserInput: 'Also check CSS styles for light theme',
      recentTurnsLimit: 2,
      workspacePaths: ['/Users/dev/antigravity-auto-rename'],
      brainDir: sb.brainDir,
    });

    assert.equal(ctx.userTurnCount, 3);
    assert.equal(ctx.initiationLanguage.code, 'zh');
    assert.equal(ctx.firstUserMessage, '帮我优化会话自动重命名插件');
    assert.equal(ctx.recentUserMessages.length, 2);
    assert.equal(ctx.recentUserMessages[1].turn, 3);

    const prompt = buildRenamePrompt(ctx, DEFAULT_SETTINGS);
    assert.match(prompt, /简体中文/);
    assert.match(prompt, /用户发起会话的第 1 次发言/);
    assert.match(prompt, /最近 2 次用户发言/);
  } finally {
    sb.cleanup();
  }
});

test('shouldTriggerAutoRename handles first turn, every-N turns, timing, and deduplication', () => {
  const baseSettings = { ...DEFAULT_SETTINGS, autoRenameInterval: 5, triggerTiming: 'pre' };

  assert.deepEqual(
    shouldTriggerAutoRename({ eventPhase: 'pre', userTurnCount: 1, convState: null, settings: baseSettings }),
    { trigger: true, reason: 'first_turn' }
  );

  // Already renamed turn 1
  assert.equal(
    shouldTriggerAutoRename({ eventPhase: 'pre', userTurnCount: 1, convState: { lastRenamedTurn: 1 }, settings: baseSettings }).trigger,
    false
  );

  // Turns 2..5 shouldn't trigger when interval=5 and anchor=1
  for (const turn of [2, 3, 4, 5]) {
    assert.equal(
      shouldTriggerAutoRename({ eventPhase: 'pre', userTurnCount: turn, convState: { lastRenamedTurn: 1 }, settings: baseSettings }).trigger,
      false
    );
  }

  // Turn 6 (1 + 5) triggers on 'pre'
  assert.deepEqual(
    shouldTriggerAutoRename({ eventPhase: 'pre', userTurnCount: 6, convState: { lastRenamedTurn: 1 }, settings: baseSettings }),
    { trigger: true, reason: 'interval' }
  );

  // When triggerTiming='stop', turn 6 waits on 'pre' and triggers on 'stop'
  const stopSettings = { ...baseSettings, triggerTiming: 'stop' };
  assert.equal(
    shouldTriggerAutoRename({ eventPhase: 'pre', userTurnCount: 6, convState: { lastRenamedTurn: 1 }, settings: stopSettings }).trigger,
    false
  );
  assert.deepEqual(
    shouldTriggerAutoRename({ eventPhase: 'stop', userTurnCount: 6, convState: { lastRenamedTurn: 1 }, settings: stopSettings }),
    { trigger: true, reason: 'interval' }
  );
});

test('executeConversationRename preempts turn 1, updates title via RPC mock, and supports undo', async () => {
  const sb = makeTempSandbox();
  try {
    saveSettings({ ...DEFAULT_SETTINGS, customPromptRules: '优先中文命名' }, sb.configFile);
    assert.equal(loadSettings(sb.configFile).customPromptRules, '优先中文命名');

    const titleUpdates = [];
    const promptsSeen = [];
    const mockDeps = {
      updateTitleFn: async (cid, title) => {
        titleUpdates.push({ cid, title });
        return {};
      },
      generateFn: async (prompt) => {
        promptsSeen.push(prompt);
        return { text: '开发会话自动重命名插件', modelUsed: 1050 };
      },
      listConvsFn: async () => [],
    };

    const res1 = await executeConversationRename({
      cascadeId: 'cid-test-1',
      lastUserInput: '帮我开发一个会话自动重命名插件',
      reason: 'first_turn',
      configFile: sb.configFile,
      stateFile: sb.stateFile,
      brainDir: sb.brainDir,
      deps: mockDeps,
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.title, '开发会话自动重命名插件');
    assert.equal(titleUpdates.length, 2); // 1st: quick preemption title, 2nd: AI title
    assert.match(promptsSeen[0], /优先中文命名/);

    // Custom manual title + Undo
    const resManual = await executeConversationRename({
      cascadeId: 'cid-test-1',
      customTitle: '手动修改后的标题',
      configFile: sb.configFile,
      stateFile: sb.stateFile,
      brainDir: sb.brainDir,
      deps: mockDeps,
    });
    assert.equal(resManual.title, '手动修改后的标题');

    const resUndo = await undoConversationRename({
      cascadeId: 'cid-test-1',
      configFile: sb.configFile,
      stateFile: sb.stateFile,
      deps: mockDeps,
    });
    assert.equal(resUndo.title, '开发会话自动重命名插件');
  } finally {
    sb.cleanup();
  }
});

test('hooks/on-hook.mjs returns valid hook contracts quickly for pre and stop', () => {
  const hookScript = join(PROJECT_ROOT, 'hooks', 'on-hook.mjs');
  const t0 = Date.now();
  const preOut = execFileSync(process.execPath, [hookScript, 'pre'], {
    input: JSON.stringify({ conversationId: '' }),
    encoding: 'utf8',
    timeout: 3000,
  });
  const stopOut = execFileSync(process.execPath, [hookScript, 'stop'], {
    input: JSON.stringify({ conversationId: '' }),
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(JSON.parse(preOut), {});
  assert.deepEqual(JSON.parse(stopOut), { decision: 'allow' });
});
