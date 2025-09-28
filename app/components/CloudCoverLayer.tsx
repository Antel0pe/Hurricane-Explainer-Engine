// CloudCoverLayer.tsx
"use client";
import * as THREE from "three";
import { useEffect, useRef } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Props = {
  url: string;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  controls: OrbitControls | null;
  enabled?: boolean;
  opacity?: number;    // 0..1 (default 0.85)
  threshold?: number;  // 0..1 (default 0.5)
};

const CLOUD_GLOBE_VERT = /* glsl */`
out vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CLOUD_GLOBE_FRAG = /* glsl */`
precision highp float;
in vec3 vWorld;
out vec4 fragColor;

uniform sampler2D cloudCoverSource; // equirect RGBA or R in [0,1]
uniform float uOpacity;             // overall opacity
uniform float uThreshold;           // 0..1 cutoff
uniform float uLonOffset;           // seam shift to match your latLonToXYZ
uniform bool  uFlipV;               // flip V if needed

// world → equirect UV (matches your trail mapping: note -z in atan)
vec2 worldToUV(vec3 p){
  vec3 n = normalize(p);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  float u = fract(lon / (2.0*3.141592653589793) + 0.5 + uLonOffset);
  float v = 0.5 - lat / 3.141592653589793;
  if (uFlipV) v = 1.0 - v;
  return vec2(u, v);
}

void main(){
  vec2 uv = worldToUV(vWorld);
  float r = texture(cloudCoverSource, uv).r;

  // hard cutoff (could switch to smoothstep for softer edges)
  if (r < uThreshold) discard;

  // white cloud with opacity scaled by signal
  float a = uOpacity;
  fragColor = vec4(1.0, 1.0, 1.0, a);
}
`;

export default function CloudCoverLayer({
  url,
  renderer,
  scene,
  camera,
  controls,
  enabled = true,
  opacity = 0.85,
  threshold = 0.5,
}: Props) {
  const texRef = useRef<THREE.Texture | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef  = useRef<THREE.ShaderMaterial | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!renderer || !scene || !camera) return;

    let disposed = false;
    const loader = new THREE.TextureLoader();

    loader.load(
      url,
      (texture) => {
        if (disposed) { texture.dispose(); return; }

        // data/atlas texture defaults
        texture.flipY = true;
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.RepeatWrapping;      // longitude wrap
        texture.wrapT = THREE.ClampToEdgeWrapping; // no pole wrap
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const globeRadius = 100;     // match ThreeGlobe default
        const overlayR    = globeRadius + 0.2; // float above the surface

        if (!meshRef.current) {
          // geometry: sphere that matches the globe
          const geom = new THREE.SphereGeometry(overlayR, 256, 128);

          const mat = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader:   CLOUD_GLOBE_VERT,
            fragmentShader: CLOUD_GLOBE_FRAG,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: THREE.NormalBlending, // clouds “on top” but not additive
            uniforms: {
              cloudCoverSource: { value: texture },   
              uOpacity:   { value: opacity },
              uThreshold: { value: threshold },
              // latLonToXYZ used lon+270° → +0.75; trail used 0.25
              // pick the one that lines up with your globe; try 0.75 first:
              uLonOffset: { value: 0.25 },
              // Your trail layer uses uFlipV = true; match that if needed:
              uFlipV:     { value: true },
            }
          });
          mat.toneMapped = false; 

          const mesh = new THREE.Mesh(geom, mat);
          mesh.frustumCulled = false;
          scene.add(mesh);

          meshRef.current = mesh;
          matRef.current  = mat;
          texRef.current  = texture;
        } else {
          const mat = matRef.current!;
          mat.uniforms.cloudCoverSource.value = texture;

          const prev = texRef.current;
          if (prev && prev !== texture) prev.dispose();
          texRef.current = texture;
        }

        // quick draw
        renderer.render(scene, camera);
      },
      undefined,
      (err) => console.error("CloudCoverLayer texture load error", err)
    );

    return () => {
      disposed = true;
      if (meshRef.current && scene) scene.remove(meshRef.current);
      (meshRef.current?.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
      (meshRef.current?.material as THREE.Material | undefined)?.dispose?.();
      meshRef.current = null;
      matRef.current  = null;
      texRef.current?.dispose(); texRef.current = null;
    };
  }, [enabled, url, renderer, scene, camera]);

  // live-update simple params without recreating
  useEffect(() => {
    if (!matRef.current) return;
    matRef.current.uniforms.uOpacity.value   = opacity;
    matRef.current.uniforms.uThreshold.value = threshold;
  }, [opacity, threshold]);

  return null;
}
