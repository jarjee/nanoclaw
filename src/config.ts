import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';

// Which subagent isolation runtime to use.
// Defaults to 'gvisor' when running inside a Docker container (/.dockerenv present),
// otherwise falls back to 'docker'. Set CONTAINER_RUNTIME=bwrap or =docker in .env
// to override (bwrap needs SYS_ADMIN cap; docker is for bare-metal installs).
const _isInDocker = fs.existsSync('/.dockerenv');
export const CONTAINER_RUNTIME =
  process.env.CONTAINER_RUNTIME || (_isInDocker ? 'gvisor' : 'docker');

// Location of the pre-compiled agent-runner dist used in bwrap/gvisor modes.
// In the orchestrator Docker image this is /opt/agent-runner/dist.
export const AGENT_RUNNER_DIST =
  process.env.AGENT_RUNNER_DIST || '/opt/agent-runner/dist';

// gVisor-specific configuration
// Platform: 'ptrace' (portable, needs SYS_PTRACE cap) or 'kvm' (faster, needs /dev/kvm)
export const GVISOR_PLATFORM = process.env.GVISOR_PLATFORM || 'ptrace';
// State directory for runsc container metadata (cleaned up on startup)
export const GVISOR_STATE_DIR =
  process.env.GVISOR_STATE_DIR || '/tmp/nanoclaw-gvisor';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
