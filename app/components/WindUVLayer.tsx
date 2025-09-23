  // WindUvLayer.tsx
  "use client";
  import * as THREE from "three";
  import { useEffect, useRef } from "react";
import { ACCUM_POINTS_FRAG, ACCUM_POINTS_VERT, DECAY_FRAG, DECAY_VERT, PREVIEW_FRAG, PREVIEW_VERT, TRAIL_OVERLAY_FRAG, TRAIL_OVERLAY_VERT, WindLayerAPI } from "./HeightMesh_Shaders";


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
    onRemove?: (api: WindLayerAPI) => void; 
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
  onRemove,
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

    const trailPointsRef = useRef<THREE.Points | null>(null);
const trailMatRef    = useRef<THREE.ShaderMaterial | null>(null);


    useEffect(() => {
      if (!renderer || !scene || !camera || !url) return;

      const loader = new THREE.TextureLoader();
      let disposed = false;

      loader.load(
        url,
        (texture) => {
          if (disposed) { texture.dispose(); return; }

    texture.flipY = false; // <-- IMPORTANT: match the mesh
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;        // <-- longitudinal wrap
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
          const UV_POINTS_STEP = 10;

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
            // potential performance bottleneck since disables threejs from not rendering things that arent visible
            // in this case makes sense because currently want particles always rendered
            pts.frustumCulled = false;
            scene.add(pts);

            uvPointsRef.current = pts;
            uvGeoRef.current    = geo;
            uvMatRef.current    = mat;
            uvTexRef.current?.dispose();
            uvTexRef.current = texture;
            uvDimsRef.current = { w: texW, h: texH };

            // --- TRAIL LAYER (green) ---
// Reuse SAME vertex shader as moving points, but different fragment shader (green)
// and its own uniforms (esp. uCurrentPosition bound to rtRead.texture)
const trailMat = new THREE.ShaderMaterial({
  vertexShader: UV_POINTS_VERT,         // same placement logic
  fragmentShader: `
    precision highp float;
    out vec4 fragColor;
    void main(){
      vec2 d = gl_PointCoord - 0.5;
      if(dot(d,d) > 0.25) discard;
      fragColor = vec4(0.0, 1.0, 0.0, 0.65); // green
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  glslVersion: THREE.GLSL3,
  side: THREE.DoubleSide,
  uniforms: {
    uTerrainTexture: { value: heightTex },            // same inputs so vertex has what it needs
    uExaggeration:   { value: typeof exaggeration === "number" ? exaggeration : 0.5 },
    uAspect:         { value: aspect },
    // keep trail a tad smaller (independent size per material)
    uPointSize:      { value: (1.5 * (window.devicePixelRatio || 1)) * 2.0 },
    uGridW:          { value: texW },
    uGridH:          { value: texH },
    uStep:           { value: 10 },
    uAboveTerrain:   { value: 0.1 },
    uCurrentPosition:{ value: rtRead.texture },       // <-- IMPORTANT: bind to current readRT
    uSimSize:        { value: new THREE.Vector2(outW, outH) },
    uPressure:       { value: pressureLevel },
    zOffset:         { value: zOffset ?? 0.0 },
  }
});

// reuse the SAME geometry so it draws at the same UV sampling
const trailPts = new THREE.Points(geo, trailMat);
trailPts.frustumCulled = false;
scene.add(trailPts);

// stash refs
trailMatRef.current = trailMat;
trailPointsRef.current = trailPts;

// --------- (A) Accumulation RT (UV-space) ---------
const accumW = texW;                 // you can downscale if you want (e.g., texW/2)
const accumH = texH;

const makeAccumRT = (w:number, h:number) => {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false
  });
  // IMPORTANT: identical settings on both A and B
  rt.texture.generateMipmaps = false;
  rt.texture.wrapS = THREE.RepeatWrapping;       // longitudes
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;  // no pole bleed
  rt.texture.flipY = false;                      // keep UV space consistent
  rt.texture.colorSpace = THREE.NoColorSpace;    // linear data
  rt.texture.needsUpdate = true;
  return rt;
};

const accumRT = makeAccumRT(accumW, accumH);
// clear to black once (empty)
{
  const cc = renderer.getClearColor(new THREE.Color()).clone();
  const ca = renderer.getClearAlpha();
  renderer.setRenderTarget(accumRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(null);
  renderer.setClearColor(cc, ca);
}

// A tiny scene that draws *points in UV clipspace* into accumRT
const accumScene = new THREE.Scene();
const accumCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const accumGeo   = new THREE.BufferGeometry();
accumGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(outW * outH * 3), 3));

const accumMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: ACCUM_POINTS_VERT,
  fragmentShader: ACCUM_POINTS_FRAG,
  uniforms: {
    uCurrentPosition: { value: readPositionRTRef.current!.texture },
    uGridW:           { value: texW },
    uGridH:           { value: texH },
    uStep:            { value: UV_POINTS_STEP },
    uSimSize:         { value: new THREE.Vector2(outW, outH) },
    uPointSize:       { value: 2.0 } // tune footprint in UV RT pixels
  },
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending   // <-- key for accumulation
});
const accumPts = new THREE.Points(accumGeo, accumMat);
accumPts.frustumCulled = false;
accumScene.add(accumPts);

// --------- (B) Small on-screen preview (bottom-left) ---------
// Standalone scene+cam that draws a full-screen triangle; we’ll use a tiny viewport
const previewScene = new THREE.Scene();
const previewCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const previewMat   = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: PREVIEW_VERT,
  fragmentShader: PREVIEW_FRAG,
  uniforms: {
    uAccum: { value: accumRT.texture },
    uGain:  { value: 6.0 } // visualization gain
  },
  depthTest: false,
  depthWrite: false,
  transparent: false
});
// const previewMesh = new THREE.Mesh(new THREE.BufferGeometry(), previewMat);
const tri = new THREE.BufferGeometry();
const verts = new Float32Array([
  -1, -1, 0,
   3, -1, 0,
  -1,  3, 0
]);
tri.setAttribute('position', new THREE.BufferAttribute(verts, 3));
const previewMesh = new THREE.Mesh(tri, previewMat);
previewScene.add(previewMesh);

// --- (C) Globe overlay that shows the accumulation texture ---
accumRT.texture.wrapS = THREE.RepeatWrapping;      // longitudes wrap
accumRT.texture.wrapT = THREE.ClampToEdgeWrapping; // avoid pole bleed

const overlayGeo = new THREE.PlaneGeometry(1, 1, 256, 128);
// we only need UVs; positions are ignored because vertex shader places by lat/lon

const overlayMat = new THREE.ShaderMaterial({
  vertexShader: TRAIL_OVERLAY_VERT,
  fragmentShader: TRAIL_OVERLAY_FRAG,
  transparent: true,
  depthTest: true,
  depthWrite: false,                 // draw over globe nicely
  blending: THREE.AdditiveBlending,  // trails pop additively
  uniforms: {
    uTrail:   { value: accumRT.texture },
    uGain:    { value: 6.0 },        // try 4–12
    uTint:    { value:new THREE.Color(0x00ff88) },
    uOpacity: { value: 0.85 },
    uLift:    { value: 0.25 }        // ~0.25 world units above globeRadius
  },
  glslVersion: THREE.GLSL3,
  side: THREE.DoubleSide
});
const overlayMesh = new THREE.Mesh(overlayGeo, overlayMat);
overlayMesh.frustumCulled = false;
scene.add(overlayMesh);

// ---- (D) Decay ping-pong target (accumRTB) ----
const accumRTB = makeAccumRT(accumW, accumH);

accumRTB.texture.wrapS = THREE.RepeatWrapping;      // longitude wraps
accumRTB.texture.wrapT = THREE.ClampToEdgeWrapping; // avoid pole bleed
accumRTB.texture.generateMipmaps = false;
accumRTB.texture.colorSpace = THREE.NoColorSpace;   // keep it linear
accumRTB.texture.needsUpdate = true;
// init black once
{
  const cc = renderer.getClearColor(new THREE.Color()).clone();
  const ca = renderer.getClearAlpha();
  renderer.setRenderTarget(accumRTB);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(null);
  renderer.setClearColor(cc, ca);
}

// ---- (E) Decay scene: full-screen triangle A->B ----
const decayScene = new THREE.Scene();
const decayCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const decayMat   = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: DECAY_VERT,
  fragmentShader: DECAY_FRAG,
  uniforms: {
    uSrc:   { value: accumRT.texture },  // start reading from A
    uDecay: { value: 1.0 }              // trail length knob (0.98–0.9995)
  },
  depthTest: false,
  depthWrite: false,
  transparent: false,
  blending: THREE.NoBlending, 
});
// Fullscreen triangle (same pattern as preview)
const decayTri = new THREE.BufferGeometry();
decayTri.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0,
     3, -1, 0,
    -1,  3, 0
  ]), 3)
);
const decayMesh = new THREE.Mesh(decayTri, decayMat);
decayScene.add(decayMesh);




// --- stash new handles on API ---
apiRef.current = {
  simScene: simSceneRef.current!,
  simCam:   simCameraRef.current!,
  simMat:   simMatRef.current!,
  readRT:   readPositionRTRef.current!,
  writeRT:  writePositionRTRef.current!,
  ptsMat:   uvMatRef.current!,
  outW, outH,
  trailMat: trailMatRef.current!,  // you already had this
  accumRT,
  accumScene,
  accumCam,
  accumMat,
  previewScene,
  previewCam,
  previewMat,
    accumRTB,               // the B buffer
  decayScene,
  decayCam,
  decayMat,

  overlayMat,   
};
onReady?.(apiRef.current);

          } else {
            // update existing
            const mat = uvMatRef.current!;
            const geo = uvGeoRef.current!;
            mat.uniforms.uTerrainTexture.value = heightTex;
            mat.uniforms.uExaggeration.value   = typeof exaggeration === "number" ? exaggeration : 0.5;
            mat.uniforms.uAspect.value         = aspect;
            mat.uniforms.uPointSize.value      = (1.5 * (window.devicePixelRatio || 1)) * 3.0;
            mat.uniforms.uGridW.value          = texW;
            mat.uniforms.uGridH.value          = texH;
            mat.uniforms.uStep.value           = 10;
            mat.uniforms.uAboveTerrain.value   = 0.01;
            mat.uniforms.zOffset.value   = zOffset;

            if (dimsChanged) {
              const outW = Math.ceil(texW / 10);
              const outH = Math.ceil(texH / 10);
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

              mat.uniforms.uPrev     = mat.uniforms.uPrev || { value: null };
              mat.uniforms.uSimSize  = mat.uniforms.uSimSize || { value: new THREE.Vector2() };
              mat.uniforms.uPrev.value    = readPositionRTRef.current.texture;
              mat.uniforms.uSimSize.value = new THREE.Vector2(outW, outH);

              if (apiRef.current) {
        apiRef.current.readRT  = readPositionRTRef.current!;
        apiRef.current.writeRT = writePositionRTRef.current!;
        apiRef.current.ptsMat  = uvMatRef.current!;
        apiRef.current.outW = outW; apiRef.current.outH = outH;
      }
            } else {
              mat.uniforms.uPrev     = mat.uniforms.uPrev || { value: null };
              mat.uniforms.uSimSize  = mat.uniforms.uSimSize || { value: new THREE.Vector2() };
              mat.uniforms.uPrev.value    = readPositionRTRef.current ? readPositionRTRef.current.texture : null;
              const dims = simDimsRef.current!;
              mat.uniforms.uSimSize.value = new THREE.Vector2(dims.w, dims.h);
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
          if (apiRef.current && typeof onRemove === "function") {
            try { onRemove(apiRef.current); } catch {}
          }

        // clean up this layer only
        uvPointsRef.current && scene?.remove(uvPointsRef.current);
        uvPointsRef.current?.geometry?.dispose();
        if (uvPointsRef.current?.material instanceof THREE.Material){
          uvPointsRef.current?.material?.dispose?.();
        }
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

        apiRef.current = null;
      };
    // re-run when these change for THIS layer only
    }, [url, renderer, scene, camera, heightTex, pressureLevel, exaggeration, UV_POINTS_VERT, UV_POINTS_FRAG, SIM_VERT, SIM_FRAG]);

    return null; // this component only side-effects into the shared scene
  }
