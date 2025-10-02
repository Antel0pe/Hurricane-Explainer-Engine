// Singleton Tweakpane hub + helpers to bind uniforms/features (no `any`)
import { Pane, FolderApi } from "tweakpane";
import * as THREE from "three";
import { Features } from "./FeatureBus";

// ——— Spec types ———
export type NumberBindingSpec = {
  type: "number";
  uniform?: string;
  min?: number; max?: number; step?: number;
  value?: number;
};
export type BooleanBindingSpec = {
  type: "boolean";
  uniform?: string;
  value?: boolean;
};
export type ColorBindingSpec = {
  type: "color";
  uniform?: string;
  value?: string | number;
};
export type Vec2BindingSpec = {
  type: "vec2";
  uniform?: string; // expects THREE.Vector2
  min?: number; max?: number; step?: number;
  value?: { x: number; y: number };
};
export type SelectBindingSpec<T extends string = string> = {
  type: "select";
  options: Record<T, unknown>;        // label -> value
  onChange?: (v: unknown) => void;    // if not binding a uniform
  value?: unknown;
};
export type ButtonSpec = {
  type: "button";
  label: string;
  onClick: () => void;
};
export type MonitorSpec = {
  type: "monitor";
  object: Record<string, unknown>;
  key: string;                        // object[key] monitored
  view?: "graph" | "text";
  min?: number; max?: number;         // for graph
  interval?: number;                  // ms
};

export type Vec3BindingSpec = {
  type: "vec3";
  uniform?: string; // expects THREE.Vector3
  min?: number; max?: number; step?: number;
  value?: { x: number; y: number; z: number };
};


export type BindingSpec =
  | NumberBindingSpec
  | BooleanBindingSpec
  | ColorBindingSpec
  | Vec2BindingSpec
  | Vec3BindingSpec
  | SelectBindingSpec
  | ButtonSpec
  | MonitorSpec;

// ---------- helpers to keep TypeScript happy (no `any`) ----------
type TPChangeEvent<T = unknown> = { value: T };

// Optional TP v4 shape; we’ll duck-type at runtime
type PaneV4 = Pane & {
  addTab?: (opts: { pages: { title: string }[] }) => { pages: unknown[] };
  exportState?: () => unknown;
  importState?: (state: unknown) => void;
  on?: (evt: "change", cb: () => void) => void;
};

function asPaneV4(p: Pane): PaneV4 {
  return p as unknown as PaneV4;
}

function getUniform(
  material: THREE.ShaderMaterial | undefined,
  name: string | undefined
): THREE.IUniform<unknown> | undefined {
  if (!material || !name) return undefined;
  const raw = (material.uniforms as Record<string, unknown>)[name];
  if (!raw || typeof raw !== "object") return undefined;
  if (!("value" in (raw as Record<string, unknown>))) return undefined;
  return raw as THREE.IUniform<unknown>;
}

function isThreeColor(v: unknown): v is THREE.Color {
  return !!v && typeof v === "object" && (v as { isColor?: boolean }).isColor === true;
}
// ------------------------------------------------------

class PaneHubClass {
  private pane: Pane | null = null;
  private tabs: { pages?: unknown[] } | null = null;
  private folders = new Map<string, FolderApi>();

  attach(container: HTMLElement): void {
    if (this.pane) return;
    this.pane = new Pane({ title: "Control Panel", container, expanded: true });

    // Preset persistence (guards for v4)
    const p4 = asPaneV4(this.pane);
    const LS_KEY = "tweakpane-presets";
    try {
      const saved = typeof window !== "undefined" ? window.localStorage.getItem(LS_KEY) : null;
      if (saved && p4.importState) p4.importState(JSON.parse(saved));
      if (p4.on && p4.exportState) {
        p4.on("change", () => {
          try {
            const state = p4.exportState && p4.exportState();
            if (state && typeof window !== "undefined") {
              window.localStorage.setItem(LS_KEY, JSON.stringify(state));
            }
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore
    }
  }

  // Optional tabs. If addTab() isn’t typed/available, we silently no-op.
  ensureTabs(labels: string[] = []): { pages?: unknown[] } | null {
    if (!this.pane) throw new Error("PaneHub not attached");
    if (!this.tabs) {
      const p4 = asPaneV4(this.pane);
      this.tabs = p4.addTab ? p4.addTab({ pages: labels.map((t) => ({ title: t })) }) : null;
    }
    return this.tabs;
  }

  private keyFor(name: string, tabIndex?: number): string {
    return tabIndex != null ? `${tabIndex}::${name}` : name;
  }

  getFolder(name: string, tabIndex?: number): FolderApi {
    if (!this.pane) throw new Error("PaneHub not attached");
    const key = this.keyFor(name, tabIndex);
    const existing = this.folders.get(key);
    if (existing) return existing;

    // If tabs are not available, just use the root pane as the parent
    const parent: unknown =
      this.tabs && tabIndex != null && Array.isArray(this.tabs.pages)
        ? this.tabs.pages[tabIndex]
        : this.pane;

    // parent is either a TabPage or the Pane itself; both have addFolder
    const folderParent = parent as { addFolder: (o: { title: string; expanded?: boolean }) => FolderApi };
    const folder = folderParent.addFolder({ title: name, expanded: true });
    this.folders.set(key, folder);
    return folder;
  }

  // Bind controls; returns cleanup
  bind(
    folderName: string,
    specs: Record<string, BindingSpec>,
    material?: THREE.ShaderMaterial,
    tabIndex?: number
  ): () => void {
    const folder = this.getFolder(folderName, tabIndex);
    const disposers: Array<() => void> = [];

    Object.entries(specs).forEach(([label, spec]) => {
      if (spec.type === "button") {
        const ctrl = folder.addButton({ title: spec.label });
        ctrl.on("click", spec.onClick);
        disposers.push(() => ctrl.dispose());
        return;
      }

      if (spec.type === "monitor") {
        const ctrl = folder.addMonitor(spec.object, spec.key, {
          view: spec.view ?? "text",
          min: spec.min,
          max: spec.max,
          interval: spec.interval ?? 200,
        } as { view?: "graph" | "text"; min?: number; max?: number; interval?: number });
        disposers.push(() => ctrl.dispose());
        return;
      }

      switch (spec.type) {
        case "number": {
          const u = getUniform(material, spec.uniform);
          const obj: Record<string, number> = {
            [label]: u ? Number(u.value as number ?? 0) : (spec.value ?? 0),
          };
          const ctrl = folder.addBinding(obj, label, {
            min: spec.min,
            max: spec.max,
            step: spec.step,
          });
          ctrl.on("change", (ev: TPChangeEvent<number>) => {
            if (u) u.value = ev.value;
          });
          disposers.push(() => ctrl.dispose());
          break;
        }

        case "boolean": {
          const u = getUniform(material, spec.uniform);
          const obj: Record<string, boolean> = {
            [label]: u ? Boolean(u.value as boolean ?? false) : (spec.value ?? false),
          };
          const ctrl = folder.addBinding(obj, label);
          ctrl.on("change", (ev: TPChangeEvent<boolean>) => {
            if (u) u.value = ev.value;
          });
          disposers.push(() => ctrl.dispose());
          break;
        }

        case "color": {
          const u = getUniform(material, spec.uniform);
          const start = (() => {
            if (u && isThreeColor(u.value)) return `#${u.value.getHexString()}`;
            if (typeof spec.value === "number")
              return `#${spec.value.toString(16).padStart(6, "0")}`;
            return (spec.value as string) ?? "#ffffff";
          })();
          const obj: Record<string, string> = { [label]: start };
          const ctrl = folder.addBinding(obj, label, { view: "color" });
          ctrl.on("change", (ev: TPChangeEvent<string>) => {
            if (!u) return;
            if (isThreeColor(u.value)) (u.value as THREE.Color).set(ev.value);
            else u.value = new THREE.Color(ev.value);
          });
          disposers.push(() => ctrl.dispose());
          break;
        }

        case "vec2": {
          const u = getUniform(material, spec.uniform);
          const v2: THREE.Vector2 =
            u?.value instanceof THREE.Vector2
              ? (u.value as THREE.Vector2)
              : new THREE.Vector2(spec.value?.x ?? 0, spec.value?.y ?? 0);

          const obj: Record<string, { x: number; y: number }> = {
            [label]: { x: v2.x, y: v2.y },
          };

          const ctrl = folder.addBinding(obj, label, {
            picker: "inline",
            expanded: true,
            x: { min: spec.min, max: spec.max, step: spec.step },
            y: { min: spec.min, max: spec.max, step: spec.step },
          } as {
            picker: "inline";
            expanded: boolean;
            x: { min?: number; max?: number; step?: number };
            y: { min?: number; max?: number; step?: number };
          });

          ctrl.on("change", (ev: TPChangeEvent<{ x: number; y: number }>) => {
            v2.set(ev.value.x, ev.value.y);
            if (u) u.value = v2;
          });
          disposers.push(() => ctrl.dispose());
          break;
        }

        case "vec3": {
          const u = getUniform(material, spec.uniform);
          const v3: THREE.Vector3 = (u?.value instanceof THREE.Vector3)
            ? u.value as THREE.Vector3
            : new THREE.Vector3(spec.value?.x ?? 0, spec.value?.y ?? 0, spec.value?.z ?? 0);

          const obj = { [label]: { x: v3.x, y: v3.y, z: v3.z } } as Record<string, any>;

          const ctrl = folder.addBinding(obj, label, {
            picker: "inline",
            expanded: true,
            x: { min: spec.min, max: spec.max, step: spec.step },
            y: { min: spec.min, max: spec.max, step: spec.step },
            z: { min: spec.min, max: spec.max, step: spec.step },
          } as any);

          ctrl.on("change", (ev: { value: { x: number; y: number; z: number } }) => {
            v3.set(ev.value.x, ev.value.y, ev.value.z);
            if (u) u.value = v3;
          });
          disposers.push(() => ctrl.dispose());
          break;
        }


        case "select": {
          const start = spec.value ?? Object.values(spec.options)[0];
          const obj: Record<string, unknown> = { [label]: start };
          const ctrl = folder.addBinding(obj, label, { options: spec.options });
          ctrl.on("change", (ev: TPChangeEvent<unknown>) => {
            spec.onChange?.(ev.value);
          });
          disposers.push(() => ctrl.dispose());
          break;
        }
      }
    });

    return () => {
      disposers.forEach((d) => d());
    };
  }

  // Feature flags/selects (cross-component) via FeatureBus
  bindFlag(
    folderName: string,
    label: string,
    featureKey: string,
    defaultValue = false,
    tabIndex?: number
  ): () => void {
    const folder = this.getFolder(folderName, tabIndex);
    const obj: Record<string, boolean> = { [label]: Features.get<boolean>(featureKey, defaultValue) };
    const ctrl = folder.addBinding(obj, label);
    ctrl.on("change", (ev: TPChangeEvent<boolean>) => Features.set<boolean>(featureKey, !!ev.value));
    return () => ctrl.dispose();
  }

  bindSelect(
    folderName: string,
    label: string,
    featureKey: string,
    options: Record<string, unknown>,
    defaultValue?: unknown,
    tabIndex?: number
  ): () => void {
    const folder = this.getFolder(folderName, tabIndex);
    const start = Features.get<unknown>(featureKey, defaultValue ?? Object.values(options)[0]);
    const obj: Record<string, unknown> = { [label]: start };
    const ctrl = folder.addBinding(obj, label, { options });
    ctrl.on("change", (ev: TPChangeEvent<unknown>) => Features.set<unknown>(featureKey, ev.value));
    return () => ctrl.dispose();
  }
}

export const PaneHub = new PaneHubClass();
