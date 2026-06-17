import { EnvironmentHealthStatus, type EnvironmentHealth } from '@appliance.sh/sdk/models';

/**
 * Map a health verdict onto the status string StatusDot already knows
 * how to color, so the health dot reads consistently with deployment /
 * environment dots elsewhere in the console:
 *   healthy      → green   (reuses `deployed`)
 *   degraded     → cyan    (reuses `deploying`; reads as "in motion")
 *   unhealthy    → red     (reuses `failed`)
 *   not_deployed → muted   (reuses `destroyed`)
 *   unknown      → muted (falls through to StatusDot's default)
 */
export function healthDotStatus(status: EnvironmentHealthStatus): string {
  switch (status) {
    case EnvironmentHealthStatus.Healthy:
      return 'deployed';
    case EnvironmentHealthStatus.Degraded:
      return 'deploying';
    case EnvironmentHealthStatus.Unhealthy:
      return 'failed';
    case EnvironmentHealthStatus.NotDeployed:
      return 'destroyed';
    default:
      return 'unknown';
  }
}

const HEALTH_LABELS: Record<EnvironmentHealthStatus, string> = {
  [EnvironmentHealthStatus.Healthy]: 'Healthy',
  [EnvironmentHealthStatus.Degraded]: 'Degraded',
  [EnvironmentHealthStatus.Unhealthy]: 'Unhealthy',
  [EnvironmentHealthStatus.NotDeployed]: 'Not deployed',
  [EnvironmentHealthStatus.Unknown]: 'Unknown',
};

export function healthLabel(status: EnvironmentHealthStatus): string {
  return HEALTH_LABELS[status] ?? 'Unknown';
}

/**
 * Whether this health record carries actionable signal worth showing.
 * `unknown` (non-Kubernetes base / unreachable cluster) and
 * `not_deployed` are noise on a card — callers hide the badge for them.
 */
export function hasHealthSignal(health: EnvironmentHealth | undefined): boolean {
  if (!health) return false;
  return (
    health.status === EnvironmentHealthStatus.Healthy ||
    health.status === EnvironmentHealthStatus.Degraded ||
    health.status === EnvironmentHealthStatus.Unhealthy
  );
}

/** Format millicores as `12m` (<1 core) or `1.25` cores. */
export function formatCpu(cpuMillicores: number): string {
  if (cpuMillicores < 1000) return `${Math.round(cpuMillicores)}m`;
  return `${(cpuMillicores / 1000).toFixed(2)} cores`;
}

/** Format a byte count with binary units (KiB/MiB/GiB). */
export function formatMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
