import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { storageGet, storageSet } from "../lib/appStorage";

export function usePersistedState<T>(
  key: string,
  initial: T
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await storageGet(key);
        if (!cancelled && raw !== null && raw !== "") {
          setState(JSON.parse(raw) as T);
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    storageSet(key, JSON.stringify(state)).catch(() => {
      /* quota */
    });
  }, [key, state, hydrated]);

  return [state, setState];
}
