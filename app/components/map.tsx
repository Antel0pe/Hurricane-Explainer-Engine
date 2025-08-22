"use client";
import {useEffect, useRef} from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {MapboxOverlay} from "@deck.gl/mapbox";
import {TerrainLayer} from "@deck.gl/geo-layers";
import {AmbientLight, DirectionalLight, LightingEffect} from "@deck.gl/core";

export default function HurricaneMap({datehour}: {datehour: string}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  // Initialize the basemap and overlay once
  useEffect(() => {
    if (!ref.current) return;

    const map = new maplibregl.Map({
      container: ref.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: [0, 20],
      zoom: 2.5,
      pitch: 70,
      bearing: -10
    });

    const overlay = new MapboxOverlay({layers: []});
    map.addControl(overlay);

    // Strong lighting so hills pop
    const ambient = new AmbientLight({intensity: 1.0});
    const sun = new DirectionalLight({intensity: 2.0, direction: [-1, -1, -0.5]});
    overlay.setProps({effects: [new LightingEffect({ambient, sun})]});

    map.on("load", () => {
      try {
        map.fitBounds([[-180, -90], [180, 90]], {padding: 24, duration: 500});
      } catch {}
    });

    mapRef.current = map;
    overlayRef.current = overlay;

    return () => {
      try { map.removeControl(overlay as unknown as maplibregl.IControl); } catch {}
      try { map.remove(); } catch {}
      overlayRef.current = null;
      mapRef.current = null;
    };
  }, []);

  // Update the terrain layer when datehour changes
  useEffect(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;

    const url = `${location.protocol}//localhost:8001/gph/${datehour}`; // match page scheme!
    const MAX_MERCATOR_LAT = 85.05112878;
    const bounds: [number, number, number, number] = [-180, -MAX_MERCATOR_LAT, 180, MAX_MERCATOR_LAT];
    const layer = new TerrainLayer({
      id: "z500",
      elevationData: url,
      bounds,

      // Mapbox Terrain-RGB → meters
      // meters = -10000 + (R*65536 + G*256 + B) * 0.1
      elevationDecoder: { rScaler: 6553.6, gScaler: 25.6, bScaler: 0.1, offset: -10000 },

      // Make it OBVIOUS first; tune down later
      elevationMultiplier: 10000,

      // Cosmetic
      wireframe: true,

      // Debug: if the image fails to load, you’ll see it here
      onError: (e: unknown) => console.error("Terrain error", e)
    });

    overlay.setProps({layers: [layer]});
  }, [datehour]);

  return <div ref={ref} style={{position: "absolute", inset: 0}}/>;
}