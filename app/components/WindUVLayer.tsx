  // WindUvLayer.tsx
  "use client";
  import * as THREE from "three";
  import { useEffect, useRef } from "react";
import { COPY_FRAG, COPY_VERT, PREVIEW_FRAG, PREVIEW_VERT, TRAIL_GLOBE_FRAG, TRAIL_GLOBE_VERT, TRAIL_OVERLAY_FRAG, TRAIL_OVERLAY_VERT, TRAIL_STAMP_MIN_VERT, VERT, WindLayerAPI } from "./HeightMesh_Shaders";


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
const trailRTRef = useRef<THREE.WebGLRenderTarget | null>(null);



    useEffect(() => {
      if (!renderer || !scene || !camera || !url) return;

      const loader = new THREE.TextureLoader();
      let disposed = false;

      // right after: if (!renderer || !scene || !camera || !url) return;

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

            
const makeTrailRT = (w: number, h: number) =>
  new THREE.WebGLRenderTarget(w, h, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });

{
  // (re)create if missing or size changed
  if (!trailRTRef.current) {
    trailRTRef.current = makeTrailRT(texW, texH);

    // clear to black (RGBA = 0,0,0,0) so it’s ready for additive writes
    const prevRT = renderer.getRenderTarget();
    const prevClr = renderer.getClearColor(new THREE.Color()).clone();
    const prevA   = renderer.getClearAlpha();

    renderer.setRenderTarget(trailRTRef.current);
    renderer.setClearColor(0x000000, 0.0);
    renderer.clear(true, false, false);

    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClr, prevA);
  }
}


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


// --- tiny on-screen preview for trailRT ---
const trailPreviewScene = new THREE.Scene();
const trailPreviewCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const trailPreviewGeom  = new THREE.PlaneGeometry(2, 2);
const trailPreviewMat   = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: PREVIEW_VERT,
  fragmentShader: PREVIEW_FRAG,
  depthWrite: false,
  depthTest: false,
  transparent: false,
  uniforms: {
    uTex: { value: trailRTRef.current!.texture },
  },
});
trailPreviewScene.add(new THREE.Mesh(trailPreviewGeom, trailPreviewMat));
// Reuse your vertex shader (positions/sample uCurrentPosition, etc.)
const TRAIL_POINTS_VERT = UV_POINTS_VERT;
const TRAIL_POINTS_FRAG = /* glsl */`
  precision highp float;
  out vec4 fragColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d,d) > 0.16) discard; // round dot
    fragColor = vec4(1.0);        // white
  }
`;

const trailPtsMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: TRAIL_POINTS_VERT,
  fragmentShader: TRAIL_POINTS_FRAG,
  depthWrite: false,
  depthTest: false,
  transparent: false,
  blending: THREE.AdditiveBlending, // use AdditiveBlending if you want trails across frames
  uniforms: {
    uTerrainTexture: { value: heightTex },
    uExaggeration:   { value: exaggeration ?? 0.5 },
    uAspect:         { value: aspect },
    uPointSize:      { value: (1.5 * (window.devicePixelRatio || 1)) * 3.0 },
    uGridW:          { value: texW },
    uGridH:          { value: texH },
    uStep:           { value: UV_POINTS_STEP },
    uAboveTerrain:   { value: 0.1 },
    uCurrentPosition:{ value: readPositionRTRef.current!.texture },
    uSimSize:        { value: new THREE.Vector2(outW, outH) },
    uPressure:       { value: pressureLevel },
    zOffset:         { value: zOffset },
  }
});

const trailScene = new THREE.Scene();
const trailPoints = new THREE.Points(geo, trailPtsMat); // reuse same geometry
trailPoints.frustumCulled = false;
trailScene.add(trailPoints);
// --- overlay (screen-space) that composites trailRT onto the main canvas ---
const overlayScene = new THREE.Scene();
const overlayCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const overlayGeom  = new THREE.PlaneGeometry(2, 2);
const overlayMat   = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: TRAIL_OVERLAY_VERT,
  fragmentShader: TRAIL_OVERLAY_FRAG,
  depthWrite: false,
  depthTest: false,
  transparent: true,
  blending: THREE.AdditiveBlending,  // add the white dots over the scene
  uniforms: { uTrail: { value: trailRTRef.current!.texture } }
});
// avoid tone mapping dimming your pure white additions
overlayMat.toneMapped = false;

overlayScene.add(new THREE.Mesh(overlayGeom, overlayMat));

// --- keep trailRT sized to the renderer’s backbuffer (call each frame or on resize) ---
const ensureTrailSize = (renderer: THREE.WebGLRenderer) => {
  const size = renderer.getSize(new THREE.Vector2());
  const dpr  = renderer.getPixelRatio();
  const W = Math.max(1, Math.floor(size.x * dpr));
  const H = Math.max(1, Math.floor(size.y * dpr));
  if (!trailRTRef.current || trailRTRef.current.width !== W || trailRTRef.current.height !== H) {
    // recreate RT
    const prevRT = trailRTRef.current;
    const newRT  = new THREE.WebGLRenderTarget(W, H, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    // clear to black
    const prev = renderer.getRenderTarget();
    const prevClr = renderer.getClearColor(new THREE.Color()).clone();
    const prevA = renderer.getClearAlpha();
    renderer.setRenderTarget(newRT);
    renderer.setClearColor(0x000000, 0.0);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClr, prevA);

    // swap & rebind everywhere
    // trailRTRef.current = newRT;
    // overlayMat.uniforms.uTrail.value = newRT.texture;
    // trailPreviewMat.uniforms.uTex.value = newRT.texture;
    overlayMat.uniforms.uTrail.value = readPositionRTRef.current;
    // clean old
    prevRT?.dispose();
  }
};

// UV-space stamping into trailRT
const trailStampCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const trailStampScene = new THREE.Scene();

const trailStampMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: TRAIL_STAMP_MIN_VERT,     // <-- NEW
  fragmentShader: TRAIL_POINTS_FRAG,      // your round white dot
  depthTest: false,
  depthWrite: false,
  transparent: true,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uCurrentPosition: { value: readPositionRTRef.current!.texture },
    uGridW:     { value: texW },
    uGridH:     { value: texH },
    uStep:      { value: UV_POINTS_STEP },
    uPointSize: { value: 1.0 },
  },
});

// Reuse the same particle geometry you already made:
const trailStampPoints = new THREE.Points(uvGeoRef.current!, trailStampMat);
trailStampPoints.frustumCulled = false;
trailStampScene.add(trailStampPoints);

// --- globe overlay that samples the UV-space trailRT ---
const globeRadius = 100; // keep in sync with your shaders/constants
const trailOverlayGeom = new THREE.SphereGeometry(globeRadius + 0.05, 256, 128);
const trailOverlayMat  = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader:   TRAIL_GLOBE_VERT,
  fragmentShader: TRAIL_GLOBE_FRAG,
  transparent: true,
  depthTest: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uTrailTex:  { value: trailRTRef.current!.texture }, // <<— sample the same RT you stamp into
    uOpacity:   { value: 0.9 },
    uTint:      { value: new THREE.Color(0x22ff88).toArray() as any },
    uLonOffset: { value: 0.25 },  // latLonToXYZ used lon+270°, i.e. +0.75 in [0,1]
    uFlipV:     { value: true },  // toggle if N/S looks flipped
  }
});
trailOverlayMat.toneMapped = false; // keep additive whites bright

const trailOverlayMesh = new THREE.Mesh(trailOverlayGeom, trailOverlayMat);
trailOverlayMesh.frustumCulled = false;
trailOverlayMesh.renderOrder   = 10;   // draw after base globe
scene.add(trailOverlayMesh);           // <— add to the MAIN scene (or globe.add(...) if you have it)



apiRef.current = {
  simScene: simSceneRef.current!,      // your created sim scene
  simCam:   simCameraRef.current!,     // your ortho cam
  simMat:   simMatRef.current!,        // your sim material
  readRT:   readPositionRTRef.current!,
  writeRT:  writePositionRTRef.current!,
  ptsMat:   uvMatRef.current!,         // the points ShaderMaterial
  outW, outH,
  trailRT:  trailRTRef.current!, 
  trailScene,
  trailPtsMat,  
  trailPreviewScene,
  trailPreviewCam,
  trailPreviewMat,
    overlayScene,
  overlayCam,
  overlayMat,
  trailStampScene,
  trailStampCam,
  trailStampMat,
    trailOverlayMesh,
  trailOverlayMat,
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

          trailRTRef.current?.dispose();
trailRTRef.current = null;


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
