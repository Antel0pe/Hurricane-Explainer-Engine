"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Vertex shader: displace plane along Z using decoded elevation
const VERT = `
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uExaggeration;

  float decodeElevation(vec3 rgb) {
    float R = floor(rgb.r * 255.0 + 0.5);
    float G = floor(rgb.g * 255.0 + 0.5);
    float B = floor(rgb.b * 255.0 + 0.5);
    return (R * 65536.0 + G * 256.0 + B) * 0.1 - 10000.0;
  }

  void main() {
    vUv = uv;
    float elev = decodeElevation(texture2D(uTexture, uv).rgb);
    vec3 pos = position;
    // Normalize elevation to 4600..6000 and displace Z; tweak scale as desired
    float t = clamp((elev - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    pos.z += uExaggeration * t;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;

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
    vec4 texel = texture2D(uTexture, vUv);
    float elev = decodeElevation(texel.rgb);

    // Map 4600..6000 to 0..1, clamp outside
    float t = clamp((elev - 4600.0) / (6000.0 - 4600.0), 0.0, 1.0);
    vec3 color = rampRedBlue(t);
    gl_FragColor = vec4(color, 1.0);
  }
`;

type Props = { pngUrl: string };

export default function HeightMesh_Shaders({ pngUrl }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

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
    let shaderMesh: THREE.Mesh | null = null;

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

    // Load the PNG as a texture and feed it to a shader material
    const loader = new THREE.TextureLoader();
    loader.load(
      pngUrl,
      (texture) => {
        // Treat PNG as data or color depending on your use case
        // For data (heightmaps), disable color transforms
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

        const geo = new THREE.PlaneGeometry(aspect, 1, 768, 768);
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uTexture: { value: texture },
            uExaggeration: { value: 0.5 },
          },
          vertexShader: VERT,
          fragmentShader: FRAG,
        });

        shaderMesh = new THREE.Mesh(geo, mat);
        scene.add(shaderMesh);

        // Frame camera to the plane
        const sphere = new THREE.Sphere();
        new THREE.Box3().setFromObject(shaderMesh).getBoundingSphere(sphere);
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

        renderOnce();
      },
      undefined,
      (err) => {
        console.error("Texture load error", err);
      }
    );

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

    // Cleanup
    return () => {
      stopped = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      if (shaderMesh) {
        (shaderMesh.geometry as THREE.BufferGeometry).dispose();
        const m = shaderMesh.material as THREE.ShaderMaterial;
        const tex = m.uniforms?.uTexture?.value as THREE.Texture | undefined;
        if (tex) tex.dispose();
        m.dispose();
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [pngUrl]);

  // Fill parent, not window
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}


