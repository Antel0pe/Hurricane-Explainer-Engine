// components/HeightMeshRGB24.tsx
"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Props = {
  pngUrl: string;
  exaggeration?: number;  // relief ~ 25% of longer side
  maxSegments?: number;   // clamp long-side vertex count (defaults to 768)
};

export default function HeightMeshRGB24({
  pngUrl,
  exaggeration = 0.25,
  maxSegments = 768,
}: Props) {
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

    let mesh: THREE.Mesh | null = null;
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

    // --- async load + build mesh ---
    (async () => {
      const resp = await fetch(pngUrl);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);

      // Downscale to cap vertex count
      const srcW = bmp.width, srcH = bmp.height;
      const longSide = Math.max(srcW, srcH);
      const scale = Math.max(1, Math.ceil(longSide / Math.max(2, maxSegments)));
      const nx = Math.max(1, Math.floor(srcW / scale));
      const ny = Math.max(1, Math.floor(srcH / scale));

      const off = new OffscreenCanvas(nx, ny);
      const ctx = off.getContext("2d", { willReadFrequently: true })!;
      (ctx as any).imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, srcW, srcH, 0, 0, nx, ny);
      const { data } = ctx.getImageData(0, 0, nx, ny);

      // Geometry
      const segX = Math.max(1, nx - 1);
      const segY = Math.max(1, ny - 1);
      const geo = new THREE.PlaneGeometry(nx, ny, segX, segY);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const uvs = geo.attributes.uv as THREE.BufferAttribute;

      const posArr = pos.array as Float32Array;
      const uvArr = uvs.array as Float32Array;
      const vertCount = pos.count;

      // Pass 1: sample elevations + min/max
      const zRaw = new Float32Array(vertCount);
      let zMin = +Infinity, zMax = -Infinity;

      for (let i = 0; i < vertCount; i++) {
        const u = uvArr[i * 2 + 0], v = uvArr[i * 2 + 1];
        const px = Math.min(nx - 1, Math.round(u * (nx - 1)));
        const py = Math.min(ny - 1, Math.round(v * (ny - 1))); // no flip
        const k = (py * nx + px) * 4;
        const R = data[k], G = data[k + 1], B = data[k + 2];
        const elev_m = ((R << 16) | (G << 8) | B) * 0.1 - 10000.0;
        zRaw[i] = elev_m;
        if (elev_m < zMin) zMin = elev_m;
        if (elev_m > zMax) zMax = elev_m;
      }

      // Pass 2: apply scaling + vertex colors
      const relief = Math.max(1e-6, zMax - zMin);
      const zScale = (Math.max(nx, ny) * exaggeration) / relief;

      const colors = new Float32Array(vertCount * 3);
      for (let i = 0; i < vertCount; i++) {
        posArr[i * 3 + 2] = zRaw[i] * zScale;
        const t = (zRaw[i] - zMin) / relief; // [0..1]
        const r = t, g = 0.0, b = 1.0 - t;   // red→blue ramp
        colors[i * 3 + 0] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
      pos.needsUpdate = true;
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();

      // Material + mesh
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.05,
      });

      mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);

      // Frame camera using bounding sphere
      const sphere = new THREE.Sphere();
      new THREE.Box3().setFromObject(mesh).getBoundingSphere(sphere);

      const fov = THREE.MathUtils.degToRad(camera.fov);
      const dist = sphere.radius / Math.sin(fov / 2);
      camera.position.set(
        sphere.center.x,
        sphere.center.y - dist * 0.2,
        sphere.center.z + sphere.radius * 1.5
      );
      camera.near = Math.max(0.1, dist * 0.001);
      camera.far = dist * 10;
      camera.updateProjectionMatrix();
      camera.lookAt(sphere.center);
      controls.target.copy(sphere.center);
      controls.update();

      // Free big temporaries
      bmp.close();
      off.width = off.height = 1;

      // Initial render
      renderOnce();
    })();

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
      if (mesh) {
        (mesh.geometry as THREE.BufferGeometry).dispose();
        const m = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) m.forEach(mm => mm.dispose()); else m.dispose();
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [pngUrl, exaggeration, maxSegments]);

  // Fill parent, not window
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}