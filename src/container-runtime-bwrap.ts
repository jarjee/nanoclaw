/**
 * Bubblewrap (bwrap) subagent runtime for NanoClaw.
 *
 * Used when NanoClaw itself runs inside a Docker container. Instead of
 * spawning child Docker containers (which would require DinD/privileged mode),
 * each subagent is sandboxed via bwrap:
 *
 *   - The orchestrator container's entire filesystem is bind-mounted read-only
 *     into the sandbox (`--ro-bind / /`), giving subagents access to Node.js,
 *     npm packages, chromium, etc. without any image management.
 *   - Per-group directories (group folder, IPC, .claude sessions) are
 *     bind-mounted writable, providing the same per-group isolation as Docker.
 *   - /proc, /dev, /tmp, /sys are replaced with fresh instances so the sandbox
 *     cannot inspect host process state or write to shared temp space.
 *   - The orchestrator's .env is hidden behind /dev/null.
 *
 * Requires: the host Docker container must be started with --cap-add=SYS_ADMIN
 * so that bwrap can call unshare(CLONE_NEWNS) to create the mount namespace.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// In-memory registry of running bwrap subagents: name → ChildProcess.
// Process table is clean on container start so no cross-restart orphans.
const bwrapProcs = new Map<string, ChildProcess>();

/**
 * Build the bwrap CLI argument list for a subagent sandbox.
 *
 * The sandbox gets:
 *   - Read-only view of the orchestrator container's entire filesystem
 *   - Fresh /proc, /dev, /tmp, /sys
 *   - Writable bind mounts for group-specific paths (from `mounts`)
 *   - /app/.env hidden behind /dev/null
 */
export function buildBwrapArgs(
  mounts: VolumeMount[],
  env: Record<string, string>,
  agentRunnerDist: string,
): string[] {
  const args: string[] = [
    // Bind the entire orchestrator container filesystem read-only.
    // This gives the sandbox Node.js, npm packages, chromium, and all
    // system libraries without enumerating distro-specific paths.
    '--ro-bind', '/', '/',

    // Replace kernel-provided filesystems with fresh instances.
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/sys',
  ];

  // Hide the orchestrator's .env so subagents cannot read secrets directly.
  // Secrets are passed via stdin JSON instead (see readSecrets() in container-runner.ts).
  const appEnvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(appEnvPath)) {
    args.push('--ro-bind', '/dev/null', appEnvPath);
  }

  // Per-group writable mounts override the read-only base above.
  for (const mount of mounts) {
    args.push(mount.readonly ? '--ro-bind' : '--bind', mount.hostPath, mount.containerPath);
  }

  // Environment — only forward what the subagent needs.
  args.push('--setenv', 'HOME', '/home/node');
  args.push('--setenv', 'AGENT_BROWSER_EXECUTABLE_PATH', '/usr/bin/chromium');
  args.push('--setenv', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', '/usr/bin/chromium');
  for (const [key, value] of Object.entries(env)) {
    args.push('--setenv', key, value);
  }

  // Start the sandbox in the group workspace directory.
  args.push('--chdir', '/workspace/group');

  // New session so the sandbox doesn't share a controlling terminal.
  args.push('--new-session');

  // Run the pre-compiled agent-runner directly — no tsc step needed.
  args.push('node', `${agentRunnerDist}/index.js`);

  return args;
}

/** Register a spawned bwrap process so it can be found for graceful stop. */
export function registerBwrapProcess(name: string, proc: ChildProcess): void {
  bwrapProcs.set(name, proc);
  proc.on('close', () => bwrapProcs.delete(name));
}

/** Gracefully stop a named bwrap sandbox (SIGTERM → caller handles SIGKILL fallback). */
export function stopBwrapContainer(name: string): void {
  const proc = bwrapProcs.get(name);
  if (proc) {
    proc.kill('SIGTERM');
  }
}

/**
 * Clean up bwrap orphans on startup.
 *
 * Because the process table starts fresh each time the NanoClaw container
 * starts, there are no orphaned bwrap processes to clean up. This function
 * exists to satisfy the same interface as the Docker orphan cleanup.
 */
export function cleanupBwrapOrphans(): void {
  // No-op: bwrap processes are tracked in-memory only; they don't outlive
  // the orchestrator process that spawned them.
}
