"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Shared GLSL utilities reused by vertex shaders
const get_position_z_shared_glsl = `
  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    return (R * 65536.0 + G * 256.0 + B) * 0.1 - 10000.0;
  }

  float get_position_z(sampler2D tex, vec2 uv, float exaggeration) {
    float elev = decodeElevation(texture2D(tex, uv).rgb);
    float t = clamp((elev - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    return exaggeration * t;
  }
`;

// Vertex shader: displace plane along Z using decoded elevation
const VERT = `
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uExaggeration;

  ${get_position_z_shared_glsl}

  void main() {
    vUv = uv;
    vec3 pos = position;
    pos.z = position.z + get_position_z(uTexture, uv, uExaggeration);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform sampler2D uLandTexture;
  uniform float uExaggeration;
  uniform vec2 uTexelSize;    // 1.0 / (texture width, height)
  uniform vec2 uUvToWorld;    // (aspect, 1.0) to scale UV steps to world XY
  uniform vec3 uLightDir;     // normalized light direction

  // Decode RGB24 to meters: elev_m = ((R<<16)|(G<<8)|B)*0.1 - 10000.0
  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    float scaled = R * 65536.0 + G * 256.0 + B;
    return scaled * 0.1 - 10000.0;
  }

  vec3 rampRedBlue(float t) {
    return mix(vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), t);
  }

  void main() {
    // Base color from decoded elevation (red-blue ramp)
    float elevC = decodeElevation(texture2D(uTexture, vUv).rgb);
    float tC = clamp((elevC - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    vec3 base = rampRedBlue(tC);

    // Per-pixel normal from finite differences on normalized height (same mapping as vertex displacement)
    float elevR = decodeElevation(texture2D(uTexture, vUv + vec2(uTexelSize.x, 0.0)).rgb);
    float elevU = decodeElevation(texture2D(uTexture, vUv + vec2(0.0, uTexelSize.y)).rgb);
    float tR = clamp((elevR - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    float tU = clamp((elevU - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);

    // Build tangent vectors in world units: delta in X/Y and corresponding Z change
    vec3 dX = vec3(uUvToWorld.x * uTexelSize.x, 0.0, (tR - tC) * uExaggeration);
    vec3 dY = vec3(0.0, uUvToWorld.y * uTexelSize.y, (tU - tC) * uExaggeration);
    vec3 N = normalize(cross(dY, dX));

    // Simple Lambert with ambient so it doesn't get too dark
    float lambert = max(dot(N, normalize(uLightDir)), 0.0);
    float ambient = 0.35;
    float diffuse = 0.65 * lambert;
    vec3 color = base * (ambient + diffuse);

    // Land mask: if land texture is black, force black output; if white, keep color
    vec3 landRgb = texture2D(uLandTexture, vUv).rgb;
    float landWhiteLevel = max(max(landRgb.r, landRgb.g), landRgb.b);
    float isLand = step(0.5, 1.0 - landWhiteLevel);
    color = mix(color, vec3(0.0), isLand * 0.25);

    gl_FragColor = vec4(color, 1.0);
  }
`;

type Props = { pngUrl: string; landUrl?: string; exaggeration?: number };

export default function HeightMesh_Shaders({ pngUrl, landUrl, exaggeration }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const sunRef = useRef<THREE.DirectionalLight | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const landTexRef = useRef<THREE.Texture | null>(null);
  const [landTexVersion, setLandTexVersion] = useState(0);

  useEffect(() => {
    const host = hostRef.current!;
    const getSize = () => {
      const r = host.getBoundingClientRect();
      return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
      };
    const { w, h } = getSize();

    // --- renderer / scene / camera ---
    const renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2 });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
    renderer.setSize(w, h);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f9fc);

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1e9);
    camera.up.set(0, 0, 1);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(1.5, 1.0, 2.0).multiplyScalar(1000);
    scene.add(sun);

    let stopped = false;

    // --- render-on-demand (guarded; no recursive re-entry) ---
    let rafId: number | null = null;
    let animating = false;

    const render = () => renderer.render(scene, camera);

    const startDampedRAF = () => {
      if (stopped || animating) return; // start only once
      animating = true;

      const tick = () => {
        if (stopped) return;
        const needsUpdate = controls.update(); // may emit 'change'
        render();
        if (needsUpdate) {
          rafId = requestAnimationFrame(tick);
        } else {
          animating = false;
          rafId = null;
        }
      };

      tick();
    };

    const renderOnce = () => {
      if (stopped) return;
      render();
    };

    controls.addEventListener("start", startDampedRAF);
    controls.addEventListener("end", renderOnce);
    controls.addEventListener("change", () => {
      // If damping loop isn't running, at least render this change once.
      if (!animating) renderOnce();
    });

    // Initial render (no mesh yet)
    renderOnce();

    // Resize to parent
    const ro = new ResizeObserver(() => {
      const { w, h } = getSize();
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderOnce();
    });
    ro.observe(host);

    // Stash refs for reuse
    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    sunRef.current = sun;
    roRef.current = ro;

    // Cleanup
    return () => {
      stopped = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      if (meshRef.current) {
        (meshRef.current.geometry as THREE.BufferGeometry).dispose();
        const m = meshRef.current.material as THREE.ShaderMaterial;
        const tex = m.uniforms?.uTexture?.value as THREE.Texture | undefined;
        if (tex) tex.dispose();
        m.dispose();
        meshRef.current = null;
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, []);

  // Load/replace texture and update or create the mesh when pngUrl changes
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const sun = sunRef.current;
    if (!renderer || !scene || !camera || !controls || !sun) return;

    const loader = new THREE.TextureLoader();
    loader.load(
      pngUrl,
      (texture) => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const imageData = texture.image as unknown;
        let texWidth = 1;
        let texHeight = 1;
        if (
          imageData &&
          typeof (imageData as { width?: number }).width === "number" &&
          typeof (imageData as { height?: number }).height === "number"
        ) {
          texWidth = (imageData as { width: number }).width;
          texHeight = (imageData as { height: number }).height;
        }
        const aspect = texHeight !== 0 ? texWidth / texHeight : 1.0;
        const texelSize = new THREE.Vector2(1 / Math.max(1, texWidth), 1 / Math.max(1, texHeight));
        const uvToWorld = new THREE.Vector2(aspect, 1.0);
        const lightDir = sun.position.clone().normalize().negate();

        if (!meshRef.current) {
          const geo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          const mat = new THREE.ShaderMaterial({
            uniforms: {
              uTexture: { value: texture },
              uExaggeration: { value: 0.5 },
              uTexelSize: { value: texelSize },
              uUvToWorld: { value: uvToWorld },
              uLightDir: { value: lightDir },
              uLandTexture: { value: landTexRef.current },
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
          });
          const mesh = new THREE.Mesh(geo, mat);
          scene.add(mesh);
          meshRef.current = mesh;
        } else {
          const mesh = meshRef.current;
          const mat = mesh.material as THREE.ShaderMaterial;
          const prevTex = mat.uniforms?.uTexture?.value as THREE.Texture | undefined;
          mat.uniforms.uTexture.value = texture;
          mat.uniforms.uTexelSize.value = texelSize;
          mat.uniforms.uUvToWorld.value = uvToWorld;
          mat.uniforms.uLightDir.value = lightDir;
          if (prevTex) prevTex.dispose();

          const newGeo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
          (mesh.geometry as THREE.BufferGeometry).dispose();
          mesh.geometry = newGeo;
        }

        const sphere = new THREE.Sphere();
        new THREE.Box3().setFromObject(meshRef.current!).getBoundingSphere(sphere);
        const fov = THREE.MathUtils.degToRad(camera.fov);
        const dist = sphere.radius / Math.sin(fov / 2);
        camera.position.set(
          sphere.center.x,
          sphere.center.y - dist * 0.2,
          sphere.center.z + sphere.radius * 2
        );
        camera.near = Math.max(0.1, dist * 0.001);
        camera.far = dist * 10;
        camera.updateProjectionMatrix();
        camera.lookAt(sphere.center);
        controls.target.copy(sphere.center);
        controls.update();

        renderer.render(scene, camera);
      },
      undefined,
      (err) => {
        console.error("Texture load error", err);
      }
    );
  }, [pngUrl, exaggeration, landTexVersion]);

  // Load/replace land mask texture when landUrl changes
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!scene || !landUrl) return;

    const loader = new THREE.TextureLoader();
    let disposed = false;
    loader.load(
      landUrl,
      (tex) => {
        if (disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        landTexRef.current = tex;
        setLandTexVersion((v) => v + 1);
        const mesh = meshRef.current;
        if (mesh) {
          const mat = mesh.material as THREE.ShaderMaterial;
          const prevLand = mat.uniforms?.uLandTexture?.value as THREE.Texture | undefined;
          mat.uniforms.uLandTexture = mat.uniforms.uLandTexture || { value: null };
          mat.uniforms.uLandTexture.value = tex;
          if (prevLand) prevLand.dispose();
        }
        if (renderer && camera && meshRef.current) {
          renderer.render(scene, camera);
        }
      },
      undefined,
      () => {}
    );

    return () => {
      disposed = true;
    };
  }, [landUrl]);

  // Fill parent, not window
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}


