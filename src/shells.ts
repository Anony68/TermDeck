import type { ShellKind } from './types';

export interface ShellMeta {
  kind: ShellKind;
  label: string;
  badge: string;
  /** CSS variable holding the shell's accent color. */
  colorVar: string;
}

export const SHELLS: Record<ShellKind, ShellMeta> = {
  powershell: { kind: 'powershell', label: 'PowerShell', badge: 'PS', colorVar: '--sh-ps' },
  cmd: { kind: 'cmd', label: 'CMD', badge: '>_', colorVar: '--sh-cmd' },
  'git-bash': { kind: 'git-bash', label: 'Git Bash', badge: 'GB', colorVar: '--sh-gb' },
  wsl: { kind: 'wsl', label: 'WSL', badge: 'W', colorVar: '--sh-wsl' },
};

export const SHELL_ORDER: ShellKind[] = ['powershell', 'cmd', 'git-bash', 'wsl'];
