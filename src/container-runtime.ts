/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { CONTAINER_RUNTIME } from './config.js';
import { cleanupBwrapOrphans } from './container-runtime-bwrap.js';
import { cleanupGVisorOrphans } from './container-runtime-gvisor.js';
import { logger } from './logger.js';

/** The Docker/apple-container runtime binary name (unused in bwrap mode). */
export const CONTAINER_RUNTIME_BIN =
  CONTAINER_RUNTIME === 'bwrap' ? 'bwrap' : CONTAINER_RUNTIME;

/** Returns CLI args for a readonly Docker bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a Docker container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the subagent runtime is available, exiting with a clear error if not. */
export function ensureContainerRuntimeRunning(): void {
  if (CONTAINER_RUNTIME === 'gvisor') {
    try {
      execSync('which runsc', { stdio: 'pipe', timeout: 5000 });
      logger.debug('gVisor (runsc) runtime available');
    } catch (err) {
      logger.error({ err }, 'runsc not found');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: gVisor (runsc) is not installed                        ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a sandbox runtime. To fix:          ║',
      );
      console.error(
        '║  1. Install gVisor: https://gvisor.dev/docs/user_guide/install ║',
      );
      console.error(
        '║  2. Or switch to bwrap: set CONTAINER_RUNTIME=bwrap in .env    ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('gVisor (runsc) is required but not found');
    }
    return;
  }

  if (CONTAINER_RUNTIME === 'bwrap') {
    try {
      execSync('which bwrap', { stdio: 'pipe', timeout: 5000 });
      logger.debug('bwrap runtime available');
    } catch (err) {
      logger.error({ err }, 'bwrap not found');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: bubblewrap (bwrap) is not installed                    ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a sandbox runtime. To fix:          ║',
      );
      console.error(
        '║  1. Install bubblewrap: apt-get install bubblewrap             ║',
      );
      console.error(
        '║  2. Or switch to gVisor: set CONTAINER_RUNTIME=gvisor in .env  ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('bwrap is required but not found');
    }
    return;
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw subagents from previous runs. */
export function cleanupOrphans(): void {
  if (CONTAINER_RUNTIME === 'gvisor') {
    // runsc persists state on disk; orphaned entries from a crashed orchestrator
    // need explicit cleanup via `runsc delete`.
    cleanupGVisorOrphans();
    return;
  }

  if (CONTAINER_RUNTIME === 'bwrap') {
    // bwrap processes are tracked in-memory only; they don't outlive the
    // orchestrator process. On a fresh container start there are no orphans.
    cleanupBwrapOrphans();
    return;
  }

  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
