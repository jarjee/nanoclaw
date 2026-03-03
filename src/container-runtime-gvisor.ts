/**
 * gVisor (runsc) subagent runtime for NanoClaw.
 *
 * gVisor runs each subagent inside a lightweight virtual machine with its own
 * user-space kernel (the "Sentry"). Every syscall the subagent makes is
 * intercepted by the Sentry rather than passed directly to the host kernel.
 * This means a kernel exploit inside the sandbox cannot reach the host —
 * the attack surface is gVisor's Sentry rather than the full Linux kernel.
 *
 * Compared to bubblewrap (namespace-based isolation):
 *   - Stronger: no shared kernel; syscall interception is the boundary
 *   - More portable: ptrace mode needs no KVM, only SYS_PTRACE capability
 *   - Slightly slower: syscall overhead through Sentry (~10–20% for I/O workloads)
 *   - More complex: requires an OCI bundle per sandbox invocation
 *
 * How it works here:
 *   - The orchestrator's filesystem is used as the container root (read-only)
 *   - Per-group paths (workspace, IPC, .claude sessions) bind-mount writable
 *   - /app/.env is shadowed with /dev/null (secrets arrive via stdin instead)
 *   - An OCI config.json is written to a per-invocation bundle dir in /tmp
 *   - `runsc run --bundle <dir>` starts the sandbox; stdin/stdout stream through
 *   - Bundle dirs are cleaned up when the process exits
 *
 * Requires: --cap-add=SYS_PTRACE in docker-compose (ptrace mode)
 * Optional: --device /dev/kvm for faster KVM mode (set GVISOR_PLATFORM=kvm)
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// runsc state root — all container state lives here (cleaned up on startup)
const GVISOR_STATE_DIR =
  process.env.GVISOR_STATE_DIR || '/tmp/nanoclaw-gvisor';

// Platform selects the syscall interception mechanism:
//   'ptrace' — portable, works in Docker with SYS_PTRACE cap, no KVM needed
//   'kvm'    — faster, requires /dev/kvm (add 'devices: [/dev/kvm]' to compose)
const GVISOR_PLATFORM = process.env.GVISOR_PLATFORM || 'ptrace';

// In-memory registry: container id → ChildProcess
const gvisorProcs = new Map<string, ChildProcess>();

/**
 * Build an OCI runtime config for the subagent sandbox.
 *
 * root.path = "/" uses the orchestrator container's own filesystem as the
 * read-only base. Per-group mounts then overlay writable paths on top.
 * This is the same conceptual approach as bwrap's --ro-bind / /, expressed
 * in the OCI bundle format that runsc expects.
 */
function buildOCIConfig(
  mounts: VolumeMount[],
  env: Record<string, string>,
  agentRunnerDist: string,
  appEnvPath: string | null,
): object {
  const envArray = [
    'HOME=/home/node',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
  ];

  // Base mounts: replace kernel-provided filesystems with fresh instances
  const ociMounts: object[] = [
    { destination: '/proc', type: 'proc', source: 'proc' },
    {
      destination: '/dev',
      type: 'tmpfs',
      source: 'tmpfs',
      options: ['nosuid', 'noexec', 'mode=755'],
    },
    { destination: '/tmp', type: 'tmpfs', source: 'tmpfs' },
    { destination: '/sys', type: 'tmpfs', source: 'tmpfs' },
  ];

  // Hide the orchestrator's .env — secrets arrive via stdin JSON instead
  if (appEnvPath) {
    ociMounts.push({
      destination: appEnvPath,
      type: 'bind',
      source: '/dev/null',
      options: ['bind', 'ro'],
    });
  }

  // Per-group writable mounts override the read-only base
  for (const mount of mounts) {
    ociMounts.push({
      destination: mount.containerPath,
      type: 'bind',
      source: mount.hostPath,
      options: mount.readonly ? ['rbind', 'ro'] : ['rbind', 'rw'],
    });
  }

  return {
    ociVersion: '1.0.0',
    process: {
      user: { uid: 0, gid: 0 },
      args: ['node', `${agentRunnerDist}/index.js`],
      env: envArray,
      cwd: '/workspace/group',
      noNewPrivileges: true,
    },
    // Use the orchestrator container's own filesystem as the sandbox root.
    // gVisor's Sentry serves all reads through its VFS layer — the sandboxed
    // process never directly calls host kernel FS syscalls.
    root: { path: '/', readonly: true },
    mounts: ociMounts,
    linux: {
      namespaces: [
        { type: 'pid' },
        { type: 'ipc' },
        { type: 'uts' },
        { type: 'mount' },
        // network namespace is managed by gVisor in host-passthrough mode
        { type: 'network' },
      ],
    },
  };
}

/**
 * Spawn a gVisor sandbox for a subagent.
 * Creates an OCI bundle, runs `runsc run`, and returns the ChildProcess
 * so the caller can pipe stdin/stdout exactly as with Docker or bwrap.
 */
export function spawnGVisorContainer(
  id: string,
  mounts: VolumeMount[],
  env: Record<string, string>,
  agentRunnerDist: string,
  appEnvPath: string | null,
): ChildProcess {
  const bundleDir = path.join(GVISOR_STATE_DIR, 'bundles', id);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.mkdirSync(GVISOR_STATE_DIR, { recursive: true });

  const config = buildOCIConfig(mounts, env, agentRunnerDist, appEnvPath);
  fs.writeFileSync(
    path.join(bundleDir, 'config.json'),
    JSON.stringify(config, null, 2),
  );

  const proc = spawn(
    'runsc',
    [
      '--root', GVISOR_STATE_DIR,
      '--platform', GVISOR_PLATFORM,
      '--network', 'host', // agents need internet (WebSearch, WebFetch)
      '--log', '/dev/stderr',
      'run',
      '--bundle', bundleDir,
      id,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  gvisorProcs.set(id, proc);

  proc.on('close', () => {
    gvisorProcs.delete(id);
    // Clean up OCI bundle
    fs.rmSync(bundleDir, { recursive: true, force: true });
    // Clean up runsc state entry (may already be gone if runsc cleaned up)
    try {
      execSync(`runsc --root ${GVISOR_STATE_DIR} delete --force ${id}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      /* already cleaned up */
    }
  });

  return proc;
}

/** Gracefully stop a named gVisor sandbox (SIGTERM via runsc, then hard kill). */
export function stopGVisorContainer(id: string): void {
  try {
    execSync(
      `runsc --root ${GVISOR_STATE_DIR} kill ${id} SIGTERM`,
      { stdio: 'pipe', timeout: 5000 },
    );
  } catch {
    // runsc kill failed (container may already be gone); fall back to process signal
    const proc = gvisorProcs.get(id);
    if (proc) proc.kill('SIGTERM');
  }
}

/**
 * Clean up any leftover gVisor state and bundle dirs from previous runs.
 * Unlike bwrap (in-memory only), runsc persists state in GVISOR_STATE_DIR,
 * so orphaned entries from a crashed orchestrator need explicit cleanup.
 */
export function cleanupGVisorOrphans(): void {
  // Kill any containers still listed in the state dir
  try {
    const output = execSync(
      `runsc --root ${GVISOR_STATE_DIR} list --format=json`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
    );
    const containers: Array<{ id: string }> = JSON.parse(output || '[]');
    for (const { id } of containers) {
      try {
        execSync(`runsc --root ${GVISOR_STATE_DIR} delete --force ${id}`, {
          stdio: 'pipe',
          timeout: 5000,
        });
      } catch {
        /* already gone */
      }
    }
    if (containers.length > 0) {
      // logger not imported here to avoid circular deps; caller logs this
      console.error(
        `[gvisor] cleaned up ${containers.length} orphaned sandbox(es)`,
      );
    }
  } catch {
    /* no state dir yet, or runsc not found — handled by ensureContainerRuntimeRunning */
  }

  // Remove stale bundle dirs
  const bundleBase = path.join(GVISOR_STATE_DIR, 'bundles');
  if (fs.existsSync(bundleBase)) {
    fs.rmSync(bundleBase, { recursive: true, force: true });
  }
}
