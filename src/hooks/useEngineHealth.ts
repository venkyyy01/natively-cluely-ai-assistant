/**
 * NAT-802: useEngineHealth hook.
 * Polls engine health IPC every 30 s and provides a simple status summary.
 */
import { useState, useEffect, useCallback } from 'react';

export interface EngineHealth {
  ane: 'ok' | 'disabled' | 'error';
  foundationIntent: 'ok' | 'disabled' | 'unavailable';
  stealth: 'ok' | 'degraded' | 'off';
  ollamaMetal: 'ok' | 'unavailable' | 'unknown';
  workerThreadCount: number;
  timestamp: number;
}

export type HealthStatus = 'healthy' | 'degraded' | 'unknown';

function deriveStatus(health: EngineHealth | null): HealthStatus {
  if (!health) return 'unknown';
  if (health.ane === 'error') return 'degraded';
  if (health.foundationIntent === 'unavailable' && health.ollamaMetal === 'unavailable') return 'degraded';
  if (health.stealth === 'off') return 'degraded';
  return 'healthy';
}

const POLL_INTERVAL_MS = 30_000;

export function useEngineHealth() {
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [status, setStatus] = useState<HealthStatus>('unknown');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await (window as any).electronAPI?.getEngineHealth?.();
      if (result) {
        setHealth(result as EngineHealth);
        setStatus(deriveStatus(result as EngineHealth));
      }
    } catch {
      // silently fail — health is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { health, status, loading, refresh };
}
