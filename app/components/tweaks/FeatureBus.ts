// Tiny global pub/sub for cross-component feature flags (no `any`)

export type FeatureKey = string; // e.g. "clouds.enabled", "clouds.style"

type Listener<T = unknown> = (value: T) => void;

class FeatureBus {
  private map = new Map<FeatureKey, unknown>();
  private subs = new Map<FeatureKey, Set<Listener>>();

  get<T = unknown>(key: FeatureKey, fallback?: T): T {
    return (this.map.has(key) ? (this.map.get(key) as T) : (fallback as T));
  }

  set<T = unknown>(key: FeatureKey, value: T): void {
    this.map.set(key, value);
    const s = this.subs.get(key);
    if (s) s.forEach((fn) => fn(value));
  }

  subscribe<T = unknown>(key: FeatureKey, fn: (v: T) => void): () => void {
    let s = this.subs.get(key);
    if (!s) {
      s = new Set<Listener>();
      this.subs.set(key, s);
    }
    // Store with erased type, but the callback stays typed to T
    s.add(fn as Listener);

    if (this.map.has(key)) fn(this.map.get(key) as T);

    return () => {
      const set = this.subs.get(key);
      if (set) set.delete(fn as Listener);
    };
  }
}

export const Features = new FeatureBus();
