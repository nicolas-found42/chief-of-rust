import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { GoogleStatus } from "@chief-of-staff-demo/shared";
import { googleApi } from "./clients/workspace";
import { GoogleConnectionContext } from "./useGoogleConnection";

export function GoogleConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await googleApi.status());
    } catch {
      // The last known answer stands: a request that failed is not evidence the
      // connection changed, and blanking it would drop a standing warning.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ status, refresh }), [status, refresh]);

  return (
    <GoogleConnectionContext.Provider value={value}>{children}</GoogleConnectionContext.Provider>
  );
}
