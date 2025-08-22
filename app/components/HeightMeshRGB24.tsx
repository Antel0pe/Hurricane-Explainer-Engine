// components/HeightMeshRGB24.tsx
"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export default function HeightMeshRGB24({
  pngUrl,
  exaggeration = 0.25, // relief ~ 25% of longer side
}: { pngUrl: string; exaggeration?: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const getSize = () => {
      const r = host.getBoundingClientRect();
      return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    };
    const { w, h } = getSize();

    // renderer/scene/camera
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f9fc);

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1e9);
    camera.up.set(0, 0, 1);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(1.5, 1.0, 2.0).multiplyScalar(1000);
    scene.add(sun);

    let mesh: THREE.Mesh | null = null;
    let stopped = false;

    (async () => {
      const resp = await fetch(pngUrl);
      const bmp = await createImageBitmap(await resp.blob());
      const off = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = off.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const { data, width: nx, height: ny } = ctx.getImageData(0, 0, bmp.width, bmp.height);

      // geometry
      const segX = Math.max(1, nx - 1);
      const segY = Math.max(1, ny - 1);
      const geo = new THREE.PlaneGeometry(nx, ny, segX, segY);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const uvs = geo.attributes.uv as THREE.BufferAttribute;

      let zMin = +Infinity, zMax = -Infinity;
      for (let i = 0; i < uvs.count; i++) {
        const u = uvs.getX(i), v = uvs.getY(i);
        const px = Math.min(nx - 1, Math.round(u * (nx - 1)));
        const py = Math.min(ny - 1, Math.round(v * (ny - 1))); // you said no flip needed
        const k = (py * nx + px) * 4;
        const R = data[k], G = data[k + 1], B = data[k + 2];
        const scaled = (R << 16) | (G << 8) | B;
        const elev_m = scaled * 0.1 - 10000.0;
        zMin = Math.min(zMin, elev_m);
        zMax = Math.max(zMax, elev_m);
        pos.setZ(i, elev_m);
      }

      const relief = Math.max(1e-6, zMax - zMin);
      const longSide = Math.max(nx, ny);
      const zScale = (longSide * exaggeration) / relief;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) * zScale);
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      // Create a color attribute (one RGB triplet per vertex)
      const colors = new Float32Array(pos.count * 3);

      for (let i = 0; i < pos.count; i++) {
        const z = pos.getZ(i) / zScale; // original elevation in meters
        const t = (z - zMin) / (zMax - zMin); // normalize to [0,1]

        // Interpolate: low = red, high = blue
        const b = 1 - t;  // red fades out as height increases
        const g = 0;      // no green for now
        const r = t;      // blue fades in as height increases

        colors[i * 3 + 0] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }

      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.05,
      });

      mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);

      // frame camera
      const bb = new THREE.Box3().setFromObject(mesh);
      const size = new THREE.Vector3(); bb.getSize(size);
      const center = new THREE.Vector3(); bb.getCenter(center);
      const dist = Math.max(size.x, size.y) / (2 * Math.tan((camera.fov * Math.PI) / 360));
      camera.position.set(
        center.x,           // no horizontal offset
        center.y - dist*0.1, // closer, so you're above instead of back
        center.z + size.z*4  // much higher above the terrain
      );
      camera.lookAt(center);
      controls.target.copy(center);
      controls.update();

      // render loop
      (function loop() {
        if (stopped) return;
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(loop);
      })();
    })();

    // resize to parent
    const ro = new ResizeObserver(() => {
      const { w, h } = getSize();
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    return () => {
      stopped = true;
      ro.disconnect();
      controls.dispose();
      if (mesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [pngUrl, exaggeration]);

  // IMPORTANT: fill parent, not the window
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}