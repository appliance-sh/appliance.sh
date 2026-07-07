import { useQuery } from '@tanstack/react-query';
import { isAuthShapedError } from '@/components/friendly-error';
import { reportAuthFailure } from '@/lib/auth-signal';
import { useApplianceClient } from './use-appliance-client';
import { useSelectedCluster } from './use-selected-cluster';

export type KeyRole = 'admin' | 'member';

/** The resolved role, or 'unknown' when whoami FAILED (expired key,
 *  unreachable server). 'unknown' fails closed: operator surfaces hide,
 *  but Apps + Settings stay so the app never blanks. */
export type ResolvedKeyRole = KeyRole | 'unknown';

interface UseKeyRoleResult {
  /** The calling key's role on the selected cluster ('unknown' on failure). */
  role: ResolvedKeyRole;
  /** True until the role has actually been resolved (or defaulted). */
  isLoading: boolean;
}

/**
 * Resolve the calling key's role — the switch between the member
 * surface (apps + settings) and the operator surface (clusters,
 * bootstrap, agents, lifecycle).
 *
 * Defaults are deliberate:
 *   - No cluster selected → 'admin': an unconfigured shell is being set
 *     up by an operator, and hiding Setup from them would dead-end it.
 *   - Older api-servers 404 /keys/self → 'admin': roles didn't exist,
 *     every key was full-access.
 *   - While resolving → 'admin': the pre-role UI for everyone; a member
 *     sees operator nav for a moment rather than an admin seeing their
 *     tools blink out and back. The API enforces the boundary either
 *     way — a member key gets 403s on admin routes regardless of what
 *     the UI shows.
 *   - whoami FAILED (401/403, network) → 'unknown', NOT 'admin': a
 *     rejected or unreachable key must not unlock the operator nav.
 *     Consumers treat 'unknown' as non-admin (fail closed); Apps and
 *     Settings stay visible so the shell never blanks. Auth-shaped
 *     failures also raise the global auth-expiry banner.
 */
export function useKeyRole(): UseKeyRoleResult {
  const client = useApplianceClient();
  const { cluster } = useSelectedCluster();

  const { data, isLoading } = useQuery({
    queryKey: ['keys', 'self', cluster?.id],
    enabled: Boolean(client),
    staleTime: 60_000,
    queryFn: async (): Promise<ResolvedKeyRole> => {
      const result = await client!.whoami();
      if (!result.success) {
        // 404/older server: legacy = full access (roles didn't exist).
        if (/(^|[^0-9])404([^0-9]|$)/.test(result.error.message)) return 'admin';
        // Anything else (rejected key, unreachable server): fail closed.
        if (isAuthShapedError(result.error)) reportAuthFailure();
        return 'unknown';
      }
      return result.data.role === 'member' ? 'member' : 'admin';
    },
  });

  if (!client) return { role: 'admin', isLoading: false };
  return { role: data ?? 'admin', isLoading };
}
