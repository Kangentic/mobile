import { useEffect } from 'react';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { setInspectRoute } from './inspectState';

/**
 * Dev-only, renders nothing: mirrors the current expo-router location into
 * the inspect registry so `mobileInspect state route` can answer. Mounted
 * lazily from the root layout behind the EXPO_PUBLIC_KANGENTIC_INSPECT gate.
 */
export default function InspectRouteProbe(): null {
  const pathname = usePathname();
  const params = useGlobalSearchParams<Record<string, string>>();

  useEffect(() => {
    const stringParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') stringParams[key] = value;
    }
    setInspectRoute({ pathname, params: stringParams });
  }, [pathname, params]);

  useEffect(() => {
    return () => setInspectRoute(null);
  }, []);

  return null;
}
