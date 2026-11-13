#!/usr/bin/env node
/**
 * @fileoverview Detached background worker invoked by `hooks/on-hook.mjs`.
 * Evaluates user turn count and rename policy, then runs `executeConversationRename`.
 */

import {
  CONFIG_FILE,
  STATE_FILE,
  getConversationState,
  loadSettings,
  updateConversationState,
} from '../sidecars/panel/core/config.mjs';
import { extractConversationContext } from '../sidecars/panel/core/prompt-builder.mjs';
import {
  executeConversationRename,
  shouldTriggerAutoRename,
} from '../sidecars/panel/core/rename-engine.mjs';

async function main() {
  const phase = process.argv[2] === 'stop' ? 'stop' : 'pre';
  const rawPayload = process.env.AUTO_RENAME_HOOK_PAYLOAD || '';
  if (!rawPayload) return;

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return;
  }

  const cascadeId = String(payload?.conversationId || '').trim();
  if (!cascadeId) return;

  const settings = loadSettings(CONFIG_FILE);
  if (!settings.enabled) return;

  const transcriptPath = String(payload?.transcriptPath || '').trim();
  const lastUserInput = String(payload?.lastUserInput || '');
  const workspacePaths = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [];

  const context = await extractConversationContext({
    cascadeId,
    transcriptPath,
    lastUserInput,
    recentTurnsLimit: settings.contextRecentTurns,
    workspacePaths,
  });

  const convState = getConversationState(cascadeId, STATE_FILE);
  // Keep turn count & detected initiation language up-to-date even on non-renaming turns
  updateConversationState(
    cascadeId,
    {
      userTurnCount: context.userTurnCount,
      initiationLanguage: context.initiationLanguage.code,
      firstUserMessage: context.firstUserMessage || convState?.firstUserMessage || '',
    },
    STATE_FILE
  );

  const decision = shouldTriggerAutoRename({
    eventPhase: phase,
    userTurnCount: context.userTurnCount,
    convState,
    settings,
  });

  if (!decision.trigger) return;

  await executeConversationRename({
    cascadeId,
    transcriptPath,
    lastUserInput,
    workspacePaths,
    reason: decision.reason,
    force: false,
  });
}

main().catch(() => {
  // Background hook worker must fail silently without impacting host state
});
