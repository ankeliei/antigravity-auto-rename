/**
 * @fileoverview Core conversation rename decision logic and execution pipeline.
 * Handles native title preemption on turn 1, periodic auto-renaming every N user turns,
 * manual AI rename, custom title override, and title undo.
 */

import { basename } from 'node:path';
import {
  CONFIG_FILE,
  STATE_FILE,
  getConversationState,
  loadSettings,
  updateConversationState,
} from './config.mjs';
import {
  generateWithUtilityModel,
  listConversations,
  updateConversationTitle,
} from './ls-client.mjs';
import {
  buildQuickFallbackTitle,
  buildRenamePrompt,
  extractConversationContext,
  postprocessGeneratedTitle,
} from './prompt-builder.mjs';

const IN_FLIGHT_LOCK_TTL_MS = 15_000;

/**
 * Determines whether an automatic rename should fire for the given event phase and user turn count.
 *
 * @param {{
 *   eventPhase: 'pre'|'stop'|'watcher',
 *   userTurnCount: number,
 *   convState: Record<string, any> | null,
 *   settings: Record<string, any>,
 * }} params
 * @returns {{ trigger: boolean, reason: string }}
 */
export function shouldTriggerAutoRename({ eventPhase, userTurnCount, convState, settings }) {
  if (!settings?.enabled) {
    return { trigger: false, reason: 'disabled' };
  }
  const turns = Number(userTurnCount || 0);
  if (turns <= 0) {
    return { trigger: false, reason: 'no_user_turns' };
  }

  const lastRenamedTurn = Number(convState?.lastRenamedTurn || 0);
  if (lastRenamedTurn === turns) {
    return { trigger: false, reason: 'already_renamed_this_turn' };
  }

  // Turn 1: preempt Antigravity's native hardcoded English title generator immediately
  if (turns === 1) {
    if (settings.hookFirstTurn === false) {
      return { trigger: false, reason: 'first_turn_hook_disabled' };
    }
    if (lastRenamedTurn >= 1) {
      return { trigger: false, reason: 'first_turn_already_done' };
    }
    return { trigger: true, reason: 'first_turn' };
  }

  // Subsequent turns: rename after every N user messages
  const interval = Number(settings.autoRenameInterval || 0);
  if (interval <= 0) {
    return { trigger: false, reason: 'interval_disabled' };
  }

  const desiredTiming = settings.triggerTiming === 'stop' ? 'stop' : 'pre';
  if (eventPhase !== 'watcher' && eventPhase !== desiredTiming) {
    return { trigger: false, reason: `waiting_for_${desiredTiming}` };
  }

  const anchorTurn = lastRenamedTurn > 0 ? lastRenamedTurn : 1;
  const turnsSinceRename = turns - anchorTurn;
  if (turnsSinceRename >= interval) {
    return { trigger: true, reason: 'interval' };
  }

  // Also allow aligned multiples if the plugin was installed mid-conversation before turn 1 was tracked
  if (lastRenamedTurn === 0 && turns % interval === 0) {
    return { trigger: true, reason: 'interval' };
  }

  return { trigger: false, reason: 'interval_not_reached' };
}

/**
 * Resolves workspace folder paths associated with a conversation ID when not provided directly.
 */
async function resolveWorkspacePaths(cascadeId, explicitPaths, rpcOptions) {
  if (Array.isArray(explicitPaths) && explicitPaths.length > 0) {
    return explicitPaths;
  }
  try {
    const convs = await listConversations(rpcOptions);
    const match = convs.find((c) => c.cascadeId === cascadeId);
    if (!match?.workspaces?.length) return [];
    return match.workspaces
      .map((ws) => String(ws?.workspaceFolderAbsoluteUri || '').replace(/^file:\/\//i, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Executes conversation renaming (manual custom title or AI-generated with custom prompt).
 *
 * @param {{
 *   cascadeId: string,
 *   transcriptPath?: string,
 *   lastUserInput?: string,
 *   workspacePaths?: string[],
 *   reason?: string,
 *   customTitle?: string | null,
 *   force?: boolean,
 *   configFile?: string,
 *   stateFile?: string,
 *   brainDir?: string,
 *   rpcOptions?: object,
 *   deps?: {
 *     updateTitleFn?: typeof updateConversationTitle,
 *     generateFn?: typeof generateWithUtilityModel,
 *     listConvsFn?: typeof listConversations,
 *   },
 * }} params
 */
export async function executeConversationRename({
  cascadeId,
  transcriptPath = '',
  lastUserInput = '',
  workspacePaths = [],
  reason = 'manual',
  customTitle = null,
  force = false,
  configFile = CONFIG_FILE,
  stateFile = STATE_FILE,
  brainDir,
  rpcOptions = {},
  deps = {},
}) {
  if (!cascadeId) {
    throw new Error('缺少会话 ID (cascadeId)');
  }

  const updateTitleFn = deps.updateTitleFn || updateConversationTitle;
  const generateFn = deps.generateFn || generateWithUtilityModel;
  const listConvsFn = deps.listConvsFn || listConversations;

  const settings = loadSettings(configFile);
  const existingState = getConversationState(cascadeId, stateFile);

  // Manual custom string rename
  if (customTitle !== null && customTitle !== undefined) {
    const trimmed = String(customTitle).trim();
    if (!trimmed) {
      throw new Error('自定义标题不能为空');
    }
    await updateTitleFn(cascadeId, trimmed, rpcOptions);
    const prevTitle = existingState?.currentTitle || '';
    const updated = updateConversationState(
      cascadeId,
      {
        currentTitle: trimmed,
        previousTitle: prevTitle !== trimmed ? prevTitle : existingState?.previousTitle || '',
        lastRenamedAtMs: Date.now(),
        lastRenameSource: 'manual_input',
        inFlightAtMs: 0,
      },
      stateFile
    );
    return {
      ok: true,
      cascadeId,
      title: trimmed,
      previousTitle: updated?.previousTitle || '',
      mode: 'manual_input',
      userTurnCount: Number(existingState?.userTurnCount || 0),
    };
  }

  // Deduplicate concurrent automated triggers for the same turn
  const now = Date.now();
  if (
    !force &&
    existingState?.inFlightAtMs &&
    now - Number(existingState.inFlightAtMs) < IN_FLIGHT_LOCK_TTL_MS
  ) {
    return { ok: false, skipped: true, reason: 'in_flight' };
  }

  updateConversationState(cascadeId, { inFlightAtMs: now }, stateFile);

  try {
    const resolvedWorkspaces =
      Array.isArray(workspacePaths) && workspacePaths.length > 0
        ? workspacePaths
        : await resolveWorkspacePaths(cascadeId, [], rpcOptions);

    const context = await extractConversationContext({
      cascadeId,
      transcriptPath,
      lastUserInput,
      recentTurnsLimit: settings.contextRecentTurns,
      workspacePaths: resolvedWorkspaces,
      brainDir,
      rpcOptions,
    });

    if (context.userTurnCount <= 0 && !context.firstUserMessage) {
      updateConversationState(cascadeId, { inFlightAtMs: 0 }, stateFile);
      return { ok: false, skipped: true, reason: 'empty_conversation' };
    }

    // Read current title before modifying so Undo can restore it
    let currentHostTitle = existingState?.currentTitle || '';
    if (!currentHostTitle) {
      try {
        const convs = await listConvsFn(rpcOptions);
        const match = convs.find((c) => c.cascadeId === cascadeId);
        currentHostTitle = match?.effectiveTitle || '';
      } catch {
        // Non-fatal
      }
    }

    const quickFallback = buildQuickFallbackTitle(
      context.firstUserMessage,
      context.initiationLanguage,
      settings
    );
    const quickTitle =
      settings.addWorkspacePrefix && context.workspaceName
        ? `[${basename(context.workspaceName)}] ${quickFallback}`
        : quickFallback;

    // Crucial preemption step on Turn 1:
    // Set non-empty annotations.title immediately (<5ms) so Antigravity's native
    // maybeGenerateConversationTitle sees `ann.Title != ""` and skips English title generation.
    if (reason === 'first_turn' && !currentHostTitle) {
      await updateTitleFn(cascadeId, quickTitle, rpcOptions).catch(() => {});
    }

    const prompt = buildRenamePrompt(context, settings);
    let finalTitle = quickTitle;
    let modelUsed = settings.modelEnum;
    let usedFallback = false;

    try {
      const genRes = await generateFn(prompt, settings.modelEnum, rpcOptions);
      modelUsed = genRes.modelUsed;
      finalTitle = postprocessGeneratedTitle(genRes.text, quickTitle, {
        ...settings,
        workspaceName: context.workspaceName,
      });
    } catch {
      usedFallback = true;
      finalTitle = quickTitle;
    }

    await updateTitleFn(cascadeId, finalTitle, rpcOptions);

    const saved = updateConversationState(
      cascadeId,
      {
        initiationLanguage: context.initiationLanguage.code,
        firstUserMessage: context.firstUserMessage,
        userTurnCount: context.userTurnCount,
        lastRenamedTurn: context.userTurnCount,
        lastRenamedAtMs: Date.now(),
        previousTitle:
          currentHostTitle && currentHostTitle !== finalTitle
            ? currentHostTitle
            : existingState?.previousTitle || '',
        currentTitle: finalTitle,
        lastRenameSource: reason,
        inFlightAtMs: 0,
      },
      stateFile
    );

    // Delayed safeguard on Turn 1 in case native generator had just finished concurrently
    if (reason === 'first_turn' && !deps.updateTitleFn) {
      setTimeout(() => {
        updateTitleFn(cascadeId, finalTitle, rpcOptions).catch(() => {});
      }, 1800).unref?.();
    }

    return {
      ok: true,
      cascadeId,
      title: finalTitle,
      previousTitle: saved?.previousTitle || '',
      initiationLanguage: context.initiationLanguage,
      userTurnCount: context.userTurnCount,
      reason,
      modelUsed,
      usedFallback,
      promptUsed: prompt,
    };
  } catch (err) {
    updateConversationState(cascadeId, { inFlightAtMs: 0 }, stateFile);
    throw err;
  }
}

/**
 * Restores the previous conversation title recorded before the last rename.
 */
export async function undoConversationRename({
  cascadeId,
  configFile: _configFile = CONFIG_FILE,
  stateFile = STATE_FILE,
  rpcOptions = {},
  deps = {},
}) {
  if (!cascadeId) throw new Error('缺少会话 ID (cascadeId)');
  const updateTitleFn = deps.updateTitleFn || updateConversationTitle;
  const st = getConversationState(cascadeId, stateFile);
  const previousTitle = String(st?.previousTitle || '').trim();
  if (!previousTitle) {
    throw new Error('没有可恢复的上一版本标题');
  }
  await updateTitleFn(cascadeId, previousTitle, rpcOptions);
  const current = st?.currentTitle || '';
  updateConversationState(
    cascadeId,
    {
      currentTitle: previousTitle,
      previousTitle: current,
      lastRenamedAtMs: Date.now(),
      lastRenameSource: 'undo',
    },
    stateFile
  );
  return { ok: true, cascadeId, title: previousTitle, previousTitle: current };
}
