#!/usr/bin/env node
/**
 * @fileoverview Fast synchronous Antigravity lifecycle hook entrypoint (`PreInvocation` / `Stop`).
 * Reads hook context from stdin, spawns a detached background worker to handle
 * prompt-customized renaming without blocking the agent loop, and immediately prints
 * the required JSON hook contract to stdout.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HOOK_DIR, 'worker.mjs');
const phase = process.argv[2] === 'stop' ? 'stop' : 'pre';

function readStdinSyncSafe() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const rawPayload = readStdinSyncSafe().trim();
if (rawPayload) {
  try {
    const child = spawn(process.execPath, [WORKER_PATH, phase], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        AUTO_RENAME_HOOK_PAYLOAD: rawPayload,
      },
    });
    child.unref();
  } catch {
    // Do not fail or block the agent execution loop if worker spawn fails
  }
}

process.stdout.write(phase === 'stop' ? '{"decision":"allow"}\n' : '{}\n');
