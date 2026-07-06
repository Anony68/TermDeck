// Reads Claude Code's real per-project session state (see src-tauri/src/claude.rs).
import { invoke } from '@tauri-apps/api/core';
import { IS_TAURI } from './env';

export interface ClaudeSession {
  found: boolean;
  sessionId: string;
  model: string;
  mode: string;
  permissionMode: string;
  gitBranch: string;
  lastUser: string;
  lastAssistant: string;
  stopReason: string;
  waitingForInput: boolean;
  contextTokens: number;
  outputTokens: number;
  mtime: number;
}

const EMPTY: ClaudeSession = {
  found: false,
  sessionId: '',
  model: '',
  mode: '',
  permissionMode: '',
  gitBranch: '',
  lastUser: '',
  lastAssistant: '',
  stopReason: '',
  waitingForInput: false,
  contextTokens: 0,
  outputTokens: 0,
  mtime: 0,
};

export async function claudeSession(cwd: string): Promise<ClaudeSession> {
  if (!IS_TAURI || !cwd) return EMPTY;
  try {
    return await invoke<ClaudeSession>('claude_session', { cwd });
  } catch {
    return EMPTY;
  }
}

export interface ClaudeSessionInfo {
  sessionId: string;
  title: string;
  mtime: number;
  turns: number;
}

export async function claudeSessions(cwd: string): Promise<ClaudeSessionInfo[]> {
  if (!IS_TAURI || !cwd) return [];
  try {
    return await invoke<ClaudeSessionInfo[]>('claude_sessions', { cwd });
  } catch {
    return [];
  }
}
