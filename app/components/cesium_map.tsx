"use client";

import {useEffect, useMemo, useRef} from "react";

type SceneModeName = "3D" | "2D" | "COLUMBUS_VIEW";

export default function CesiumMap({
  datehour,
  sceneMode = "3D",
  subSample = 4,
  exaggeration = 0.2,
}: {
  datehour: string;
  sceneMode?: SceneModeName;
  subSample?: number;
  exaggeration?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any | null>(null);
  const primitiveRef = useRef<any | null>(null);

  const pngUrl = useMemo(() => {
    const proto = typeof location !== "undefined" ? location.protocol : "http:";
    return `${proto}//localhost:8001/gph/${datehour}`;
  }, [datehour]);

  // Initialize viewer once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!containerRef.current) return;
      if (viewerRef.current) return;

      const Cesium: any = await import("cesium");
      const mode = sceneMode === "2D"
        ? Cesium.SceneMode.SCENE2D
        : sceneMode === "COLUMBUS_VIEW"
        ? Cesium.SceneMode.COLUMBUS_VIEW
        : Cesium.SceneMode.SCENE3D;

      if (cancelled) return;

      const viewer = new Cesium.Viewer(containerRef.current!, {
        baseLayerPicker: false,
        timeline: false,
        animation: false,
        geocoder: false,
        homeButton: false,
        sceneMode: mode,
        terrain: undefined,
      });

      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          credit: "© OpenStreetMap",
          maximumLevel: 19,
        })
      );

      viewerRef.current = viewer;
    })();

    return () => {
      cancelled = true;
      try {
        if (primitiveRef.current && viewerRef.current) {
          viewerRef.current.scene.primitives.remove(primitiveRef.current);
          primitiveRef.current = null;
        }
        viewerRef.current?.destroy?.();
      } catch {}
      viewerRef.current = null;
    };
  }, [sceneMode]);

  // Load PNG for this datehour, decode and render as displaced mesh
  useEffect(() => {
    let aborted = false;

    (async () => {
      const viewer = viewerRef.current;
      if (!viewer) return;

      // Remove previous primitive
      if (primitiveRef.current) {
        try { viewer.scene.primitives.remove(primitiveRef.current); } catch {}
        primitiveRef.current = null;
      }

      // Fetch to read custom headers for bounds/size
      const res = await fetch(pngUrl, {mode: "cors"});
      if (!res.ok) return;

      // Parse bounds header if provided
      const boundsHdr = res.headers.get("X-Bounds");
      const bounds = boundsHdr
        ? (boundsHdr.split(",").map(Number) as [number, number, number, number])
        : ([-180, -85.05112878, 180, 85.05112878] as [number, number, number, number]);

      const blob = await res.blob();
      const img = await blobToHtmlImage(blob);
      const {imageData, width, height} = toImageData(img);

      const Cesium: any = await import("cesium");

      const mesh = buildDisplacedRectangle({
        Cesium,
        imageData,
        imgW: width,
        imgH: height,
        boundsDeg: bounds,
        subSample,
        heightFromPixel: (r: number, g: number, b: number) => {
          // Mapbox Terrain-RGB → meters
          return -10000 + (r * 65536 + g * 256 + b) * 0.1;
        },
        exaggeration,
      });

      if (aborted) return;

      const primitive = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({geometry: mesh.geometry}),
        appearance: new Cesium.MaterialAppearance({
          closed: false,
          material: new Cesium.Material({
            fabric: { type: "Image", uniforms: { image: img } },
          }),
        }),
      });

      viewer.scene.primitives.add(primitive);
      primitiveRef.current = primitive;

      const rect = Cesium.Rectangle.fromDegrees(...bounds);
      viewer.camera.flyTo({destination: rect});
    })();

    return () => {
      aborted = true;
    };
  }, [pngUrl, subSample, exaggeration]);

  return <div ref={containerRef} style={{position: "absolute", inset: 0}} />;
}

// ---------- helpers ----------
async function blobToHtmlImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return img;
  } finally {
    // Revoke after image is decoded and used by GPU; keep short lifetime here
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

function toImageData(img: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return {imageData, width: img.width, height: img.height};
}

function buildDisplacedRectangle({
  Cesium,
  imageData,
  imgW,
  imgH,
  boundsDeg,
  subSample,
  heightFromPixel,
  exaggeration,
}: any) {
  const [w, s, e, n] = boundsDeg;
  const nx = Math.max(2, Math.floor(imgW / subSample));
  const ny = Math.max(2, Math.floor(imgH / subSample));

  const positions: number[] = [];
  const sts: number[] = [];
  const indices: number[] = [];

  const toIdx = (ix: number, iy: number) => iy * nx + ix;

  for (let iy = 0; iy < ny; iy++) {
    const v = iy / (ny - 1);
    const lat = Cesium.Math.toRadians(s + v * (n - s));
    for (let ix = 0; ix < nx; ix++) {
      const u = ix / (nx - 1);
      const lon = Cesium.Math.toRadians(w + u * (e - w));

      const px = Math.min(imgW - 1, ix * subSample);
      const py = Math.min(imgH - 1, iy * subSample);
      const k = (py * imgW + px) * 4;
      const r = imageData.data[k], g = imageData.data[k + 1], b = imageData.data[k + 2];
      const h = heightFromPixel(r, g, b) * exaggeration;

      const cart = Cesium.Cartesian3.fromRadians(lon, lat, h);
      positions.push(cart.x, cart.y, cart.z);
      sts.push(u, 1 - v);
    }
  }

  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = toIdx(ix, iy);
      const b = toIdx(ix + 1, iy);
      const c = toIdx(ix + 1, iy + 1);
      const d = toIdx(ix, iy + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: new Float64Array(positions),
      }),
      st: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: new Float32Array(sts),
      }),
    },
    indices: new Uint32Array(indices),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(new Float64Array(positions)),
  });

  return {geometry};
}


