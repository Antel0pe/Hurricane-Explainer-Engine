// WindUvLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";

type WindLayerAPI = {
  simScene: THREE.Scene;
  simCam: THREE.OrthographicCamera;
  simMat: THREE.ShaderMaterial;
  readRT: THREE.WebGLRenderTarget;
  writeRT: THREE.WebGLRenderTarget;
  ptsMat: THREE.ShaderMaterial;
  outW: number;
  outH: number;
};


type Props = {
  url: string;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  heightTex: THREE.Texture | null;
  pressureLevel: number;
  exaggeration?: number;
  // your GLSL strings
  UV_POINTS_VERT: string;
  UV_POINTS_FRAG: string;
  SIM_VERT: string;
  SIM_FRAG: string;
  onReady?: (api: WindLayerAPI) => void;
  zOffset?: number;
};

export default function WindUvLayer({
  url,
  renderer,
  scene,
  camera,
  heightTex,
  pressureLevel,
  exaggeration,
  UV_POINTS_VERT,
  UV_POINTS_FRAG,
  SIM_VERT,
  SIM_FRAG,
onReady,
  zOffset,
}: Props) {
  // --- per-layer refs (do NOT share across layers)
  const uvPointsRef = useRef<THREE.Points | null>(null);
  const uvGeoRef    = useRef<THREE.BufferGeometry | null>(null);
  const uvMatRef    = useRef<THREE.ShaderMaterial | null>(null);
  const uvTexRef    = useRef<THREE.Texture | null>(null);
  const uvDimsRef   = useRef<{ w: number; h: number } | null>(null);

  const readPositionRTRef  = useRef<THREE.WebGLRenderTarget | null>(null);
  const writePositionRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const simDimsRef         = useRef<{ w: number; h: number } | null>(null);
  const simSceneRef        = useRef<THREE.Scene | null>(null);
  const simCameraRef       = useRef<THREE.OrthographicCamera | null>(null);
  const simMatRef          = useRef<THREE.ShaderMaterial | null>(null);

  const outWRef = useRef(0);
  const outHRef = useRef(0);

  const apiRef = useRef<WindLayerAPI | null>(null);

  useEffect(() => {
    if (!renderer || !scene || !camera || !url) return;

    const loader = new THREE.TextureLoader();
    let disposed = false;

    loader.load(
      url,
      (texture) => {
        if (disposed) { texture.dispose(); return; }

        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const img = texture.image as unknown as { width?: number; height?: number };
        const texW = typeof img?.width === "number" ? img.width : 0;
        const texH = typeof img?.height === "number" ? img.height : 0;
        if (texW === 0 || texH === 0) {
          uvTexRef.current?.dispose();
          uvTexRef.current = texture;
          return;
        }

        const aspect = texW / texH;
        const dimsChanged = !uvDimsRef.current || uvDimsRef.current.w !== texW || uvDimsRef.current.h !== texH;
        const UV_POINTS_STEP = 25;

        const makeRT = (w: number, h: number) =>
          new THREE.WebGLRenderTarget(w, h, {
            type: THREE.FloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false,
            stencilBuffer: false
          });

        const zeroRT = (rt: THREE.WebGLRenderTarget) => {
          const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
          const prevClearAlpha = renderer.getClearAlpha();
          renderer.setRenderTarget(rt);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, false, false);
          renderer.setRenderTarget(null);
          renderer.setClearColor(prevClearColor, prevClearAlpha);
        };

        if (!uvPointsRef.current) {
          // build fresh
          const outW = Math.ceil(texW / UV_POINTS_STEP);
          const outH = Math.ceil(texH / UV_POINTS_STEP);
          outWRef.current = outW;
          outHRef.current = outH;

          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(outW * outH * 3), 3));

          const rtRead  = makeRT(outW, outH);
          const rtWrite = makeRT(outW, outH);
          rtRead.texture.generateMipmaps = false;
          rtWrite.texture.generateMipmaps = false;
          zeroRT(rtRead);
          zeroRT(rtWrite);

          readPositionRTRef.current  = rtRead;
          writePositionRTRef.current = rtWrite;
          simDimsRef.current = { w: outW, h: outH };

          const mat = new THREE.ShaderMaterial({
            vertexShader: UV_POINTS_VERT,
            fragmentShader: UV_POINTS_FRAG,
            transparent: true,
            blending: THREE.NormalBlending,
            depthWrite: false,
            glslVersion: THREE.GLSL3,
            side: THREE.DoubleSide,
            uniforms: {
              uTerrainTexture: { value: heightTex },
              uExaggeration:   { value: exaggeration ?? 0.5 },
              uAspect:         { value: aspect },
              uPointSize:      { value: (1.5 * (window.devicePixelRatio || 1)) * 3.0 },
              uGridW:          { value: texW },
              uGridH:          { value: texH },
              uStep:           { value: UV_POINTS_STEP },
              uAboveTerrain:   { value: 0.1 },
              uCurrentPosition:{ value: rtRead.texture },
              uSimSize:        { value: new THREE.Vector2(outW, outH) },
              uPressure:       { value: pressureLevel },
              zOffset: { value: zOffset },
            }
          });

          if (!simSceneRef.current) {
            const simScene = new THREE.Scene();
            const simCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            const simGeom  = new THREE.PlaneGeometry(2, 2);
            const simMat   = new THREE.ShaderMaterial({
              glslVersion: THREE.GLSL3,
              vertexShader: SIM_VERT,
              fragmentShader: SIM_FRAG,
              uniforms: {
                uPrev:   { value: rtRead.texture },
                uDt:     { value: 0 },
                uSpeed:  { value: 0.5 },
                uSize:   { value: new THREE.Vector2(outW, outH) },
                uWindTexture: { value: texture }
              }
            });
            simScene.add(new THREE.Mesh(simGeom, simMat));
            simSceneRef.current  = simScene;
            simCameraRef.current = simCam;
            simMatRef.current    = simMat;
          } else {
            simMatRef.current!.uniforms.uPrev.value = writePositionRTRef.current!.texture;
            simMatRef.current!.uniforms.uSize.value = new THREE.Vector2(outW, outH);
          }

          const pts = new THREE.Points(geo, mat);
          scene.add(pts);

          uvPointsRef.current = pts;
          uvGeoRef.current    = geo;
          uvMatRef.current    = mat;
          uvTexRef.current?.dispose();
          uvTexRef.current = texture;
          uvDimsRef.current = { w: texW, h: texH };

              apiRef.current = {
      simScene: simSceneRef.current!,      // your created sim scene
      simCam:   simCameraRef.current!,     // your ortho cam
      simMat:   simMatRef.current!,        // your sim material
      readRT:   readPositionRTRef.current!,
      writeRT:  writePositionRTRef.current!,
      ptsMat:   uvMatRef.current!,         // the points ShaderMaterial
      outW, outH
    };
    onReady?.(apiRef.current);
        } else {
          // update existing
          const mat = uvMatRef.current!;
          const geo = uvGeoRef.current!;
          (mat.uniforms as any).uTerrainTexture.value = heightTex;
          (mat.uniforms as any).uExaggeration.value   = typeof exaggeration === "number" ? exaggeration : 0.5;
          (mat.uniforms as any).uAspect.value         = aspect;
          (mat.uniforms as any).uPointSize.value      = (1.5 * (window.devicePixelRatio || 1)) * 3.0;
          (mat.uniforms as any).uGridW.value          = texW;
          (mat.uniforms as any).uGridH.value          = texH;
          (mat.uniforms as any).uStep.value           = 25;
          (mat.uniforms as any).uAboveTerrain.value   = 0.01;
          (mat.uniforms as any).zOffset.value   = zOffset;

          if (dimsChanged) {
            const outW = Math.ceil(texW / 25);
            const outH = Math.ceil(texH / 25);
            const count = outW * outH;
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
            uvDimsRef.current = { w: texW, h: texH };

            readPositionRTRef.current?.dispose();
            writePositionRTRef.current?.dispose();
            const rtRead  = makeRT(outW, outH);
            const rtWrite = makeRT(outW, outH);
            rtRead.texture.generateMipmaps = false;
            rtWrite.texture.generateMipmaps = false;
            zeroRT(rtRead);
            zeroRT(rtWrite);

            readPositionRTRef.current  = rtRead;
            writePositionRTRef.current = rtWrite;
            simDimsRef.current         = { w: outW, h: outH };

            (mat.uniforms as any).uPrev     = (mat.uniforms as any).uPrev || { value: null };
            (mat.uniforms as any).uSimSize  = (mat.uniforms as any).uSimSize || { value: new THREE.Vector2() };
            (mat.uniforms as any).uPrev.value    = readPositionRTRef.current.texture;
            (mat.uniforms as any).uSimSize.value = new THREE.Vector2(outW, outH);

            if (apiRef.current) {
      apiRef.current.readRT  = readPositionRTRef.current!;
      apiRef.current.writeRT = writePositionRTRef.current!;
      apiRef.current.ptsMat  = uvMatRef.current!;
      apiRef.current.outW = outW; apiRef.current.outH = outH;
    }
          } else {
            (mat.uniforms as any).uPrev     = (mat.uniforms as any).uPrev || { value: null };
            (mat.uniforms as any).uSimSize  = (mat.uniforms as any).uSimSize || { value: new THREE.Vector2() };
            (mat.uniforms as any).uPrev.value    = readPositionRTRef.current ? readPositionRTRef.current.texture : null;
            const dims = simDimsRef.current!;
            (mat.uniforms as any).uSimSize.value = new THREE.Vector2(dims.w, dims.h);
          }

          uvTexRef.current?.dispose();
          uvTexRef.current = texture;
        }

        // optional: immediate draw
        renderer.render(scene, camera);
      },
      undefined,
      () => {}
    );

    return () => {
      disposed = true;
      // clean up this layer only
      uvPointsRef.current && scene?.remove(uvPointsRef.current);
      uvPointsRef.current?.geometry?.dispose();
      (uvPointsRef.current?.material as any)?.dispose?.();
      uvPointsRef.current = null;

      uvGeoRef.current?.dispose(); uvGeoRef.current = null;
      uvMatRef.current?.dispose(); uvMatRef.current = null;
      uvTexRef.current?.dispose(); uvTexRef.current = null;

      readPositionRTRef.current?.dispose();  readPositionRTRef.current = null;
      writePositionRTRef.current?.dispose(); writePositionRTRef.current = null;

      simMatRef.current?.dispose(); simMatRef.current = null;
      simSceneRef.current = null;
      simCameraRef.current = null;
      simDimsRef.current = null;
    };
  // re-run when these change for THIS layer only
  }, [url, renderer, scene, camera, heightTex, pressureLevel, exaggeration, UV_POINTS_VERT, UV_POINTS_FRAG, SIM_VERT, SIM_FRAG]);

  return null; // this component only side-effects into the shared scene
}
