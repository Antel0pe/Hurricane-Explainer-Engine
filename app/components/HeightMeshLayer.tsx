// HeightMeshLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";


export type HeightMeshAPI = {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  texture: THREE.Texture;
  aspect: number;
  texelSize: THREE.Vector2;
};

type Props = {
  // data & context
  url: string;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  controls: OrbitControls | null; // OrbitControls
  sun: THREE.Object3D | null; // e.g., DirectionalLight

  // shading
  VERT: string;
  FRAG: string;

  // uniforms
  landTexture: THREE.Texture | null; // uLandTexture
  pressureLevel: number; // uPressure
  exaggeration?: number; // uExaggeration
  zOffset?: number; // zOffset

  // behavior
  enabled?: boolean; // gate on external readiness, defaults true
  autoFrameOnce?: boolean; // frame camera to mesh first time, defaults true

  // hooks to parent
  onReady?: (api: HeightMeshAPI) => void;
  onTextureChange?: (tex: THREE.Texture) => void; // e.g. lift heightTex to parent
};

export default function HeightMeshLayer({
  url,
  renderer,
  scene,
  camera,
  controls,
  sun,
  VERT,
  FRAG,
  landTexture,
  pressureLevel,
  exaggeration,
  zOffset = 0,
  enabled = true,
  autoFrameOnce = false,
  onReady,
  onTextureChange,
}: Props) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef = useRef<THREE.ShaderMaterial | null>(null);
  const texRef = useRef<THREE.Texture | null>(null);
  const hasFramedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const rendererOk = !!renderer && !!scene && !!camera && !!controls && !!sun;
    if (!rendererOk) return;

    let disposed = false;
    const loader = new THREE.TextureLoader();

    loader.load(
      url,
      (texture) => {
        if (disposed) { texture.dispose(); return; }

        // texture params
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const img = texture.image as unknown as { width?: number; height?: number } | undefined;
        const texW = typeof img?.width === "number" ? img!.width! : 1;
        const texH = typeof img?.height === "number" ? img!.height! : 1;
        const aspect = texH !== 0 ? texW / texH : 1.0;
        const texelSize = new THREE.Vector2(1 / Math.max(1, texW), 1 / Math.max(1, texH));
        const uvToWorld = new THREE.Vector2(aspect, 1.0);
        const lightDir = sun!.position.clone().normalize().negate();

        const buildMaterial = (t: THREE.Texture) => new THREE.ShaderMaterial({
          uniforms: {
            uTexture: { value: t },
            uExaggeration: { value: typeof exaggeration === "number" ? exaggeration : 0.5 },
            uTexelSize: { value: texelSize },
            uUvToWorld: { value: uvToWorld },
            uLightDir: { value: lightDir },
            uLandTexture: { value: landTexture },
            uPressure: { value: pressureLevel },
            zOffset: { value: zOffset },
          },
          vertexShader: VERT,
          fragmentShader: FRAG,
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });

        if (!meshRef.current) {
          // create mesh
          const geo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          const mat = buildMaterial(texture);
          const mesh = new THREE.Mesh(geo, mat);
          scene!.add(mesh);

          meshRef.current = mesh;
          matRef.current = mat;
          texRef.current?.dispose();
          texRef.current = texture;

          onTextureChange?.(texture);
          onReady?.({ mesh, material: mat, texture, aspect, texelSize });
        } else {
          // update existing
          const mesh = meshRef.current as THREE.Mesh;
          const mat = matRef.current as THREE.ShaderMaterial;
          const prevTex = (mat.uniforms?.uTexture?.value as THREE.Texture | undefined) ?? undefined;

          mat.uniforms.uTexture.value = texture;
          mat.uniforms.uTexelSize.value = texelSize;
          mat.uniforms.uUvToWorld.value = uvToWorld;
          mat.uniforms.uLightDir.value = lightDir;
          mat.uniforms.uPressure.value = pressureLevel;
          mat.uniforms.zOffset.value = zOffset;
          mat.uniforms.uLandTexture.value = landTexture;

          if (prevTex) prevTex.dispose();
          texRef.current = texture;
          onTextureChange?.(texture);

          const newGeo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          (mesh.geometry as THREE.BufferGeometry).dispose();
          mesh.geometry = newGeo;
        }

        // auto-frame once
        if (autoFrameOnce && !hasFramedRef.current && meshRef.current) {
          const mesh = meshRef.current;
          const sphere = new THREE.Sphere();
          new THREE.Box3().setFromObject(mesh).getBoundingSphere(sphere);

          // assume PerspectiveCamera if it has fov
          if (camera instanceof THREE.PerspectiveCamera) {
            const cam = camera as THREE.PerspectiveCamera;
            const fov = THREE.MathUtils.degToRad(cam.fov);
            const dist = sphere.radius / Math.sin(fov / 2);
            cam.position.set(
              sphere.center.x,
              sphere.center.y - dist * 0.2,
              sphere.center.z + sphere.radius * 2
            );
            cam.near = Math.max(0.1, dist * 0.001);
            cam.far = dist * 10;
            cam.updateProjectionMatrix();
          }

          // aim & controls
          (camera as THREE.Camera).lookAt(sphere.center);
          if (controls && typeof controls === "object" && "target" in controls) {
            controls.target.copy(sphere.center);
            controls.update?.();
          }

          hasFramedRef.current = true;
        }

        renderer!.render(scene!, camera!);
      },
      undefined,
      (err) => {
        console.error("HeightMeshLayer: texture load error", err);
      }
    );

    return () => {
      disposed = true;
      if (meshRef.current && scene) scene.remove(meshRef.current);

      (meshRef.current?.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
      (meshRef.current?.material as THREE.Material | undefined)?.dispose?.();

      meshRef.current = null;
      matRef.current = null;

      texRef.current?.dispose();
      texRef.current = null;
    };
  }, [enabled, url, renderer, scene, camera, controls, sun, landTexture, pressureLevel, exaggeration, zOffset, VERT, FRAG, autoFrameOnce]);

  return null; // side-effect layer only
}
