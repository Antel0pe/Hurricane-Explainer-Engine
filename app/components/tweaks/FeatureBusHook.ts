// FeatureBusHook.ts
import { useSyncExternalStore } from "react";
import { Features } from "./FeatureBus";

export function useFeatureFlag<T = boolean>(key: string, fallback: T) {
  return useSyncExternalStore(
    (cb) => Features.subscribe(key, cb),             // your bus should call cb() on change
    () => Features.get<T>(key, fallback),
    () => Features.get<T>(key, fallback)            // SSR fallback (same as client)
  );
}
