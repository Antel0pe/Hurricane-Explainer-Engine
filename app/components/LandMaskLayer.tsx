// LandMaskLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect } from "react";

type Props = {
  landUrl: string | null;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  /** Called after the texture is created (use to update refs/state) */
  onTexture?: (tex: THREE.Texture) => void;
};

export default function LandMaskLayer({
  landUrl,
  renderer,
  scene,
  camera,
  onTexture,
}: Props) {
  useEffect(() => {
    if (!scene || !landUrl) return;

    const loader = new THREE.TextureLoader();
    let disposed = false;
    let createdTex: THREE.Texture | null = null;

    loader.load(
      landUrl,
      (tex) => {
        if (disposed) { tex.dispose(); return; }

        // Texture setup
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        createdTex = tex;
        onTexture?.(tex);
      },
      undefined,
      () => {}
    );

    return () => {
      disposed = true;
      // If this component created a texture and nothing else holds it, dispose it.
      if (createdTex) {
        try { createdTex.dispose(); } catch {}
        createdTex = null;
      }
    };
  }, [landUrl, renderer, scene, camera, onTexture]);

  return null; // side-effect only
}
