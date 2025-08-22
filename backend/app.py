import io
import os
from datetime import datetime
from typing import Tuple

import numpy as np
import xarray as xr
from PIL import Image
from flask import Flask, Response, abort


# Physical constants
STANDARD_GRAVITY_M_PER_S2: float = 9.80665


def resolve_data_path() -> str:
    """Resolve absolute path to data/data.grib relative to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    data_path = os.path.join(root, "data", "data.grib")
    return data_path


def open_era5_dataset(path: str) -> xr.Dataset:
    """Open a GRIB dataset via cfgrib. Assumes ERA5 content is present."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"GRIB file not found: {path}")

    # Note: cfgrib relies on ecCodes installed on the system.
    ds = xr.open_dataset(path, engine="cfgrib")
    return ds


def select_z500(era5_ds: xr.Dataset) -> xr.DataArray:
    """Select geopotential (z) at 500 hPa from the ERA5 dataset."""
    if "z" not in era5_ds.variables:
        raise KeyError("Variable 'z' (geopotential) not found in dataset")

    z_da = era5_ds["z"]
    # If dataset already filtered to a single level (no level dimension), use as-is
    dims = set(z_da.dims)
    if "isobaricInhPa" in dims:
        da = z_da.sel(isobaricInhPa=500)
    elif "level" in dims:
        da = z_da.sel(level=500)
    else:
        # No level dimension present; assume it's already 500 hPa
        da = z_da

    # Ensure latitude increases south->north
    if "latitude" in da.coords and da.latitude.ndim == 1 and np.any(np.diff(da.latitude.values) < 0):
        da = da.sortby("latitude")

    return da


def parse_datehour(value: str) -> datetime:
    """Parse common datehour strings into a UTC datetime.

    Accepted formats:
    - YYYYMMDDHH (e.g., 2024010112)
    - YYYY-MM-DDTHH (optionally with trailing 'Z')
    - YYYY-MM-DDTHHZ (ISO-like)
    """
    v = value.strip()
    # Digits only: YYYYMMDDHH
    if v.isdigit():
        if len(v) == 10:
            return datetime.strptime(v, "%Y%m%d%H")
        elif len(v) == 12:  # tolerate minutes
            return datetime.strptime(v, "%Y%m%d%H%M")

    # ISO-like forms
    iso = v.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H", "%Y-%m-%d %H"):
        try:
            return datetime.strptime(iso, fmt)
        except ValueError:
            pass

    # Fallback attempt: YYYY-MM-DDTHH:MM
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(iso, fmt)
        except ValueError:
            pass

    raise ValueError(f"Unsupported datehour format: {value}")


def encode_terrain_rgb_png(elev_m: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> Tuple[bytes, Tuple[float, float, float, float], int, int]:
    """Encode meters array into Mapbox Terrain-RGB-style PNG bytes with bounds.

    Returns: (png_bytes, bounds[minLon,minLat,maxLon,maxLat], nx, ny)
    """
    # Terrain-RGB encoding
    scaled = np.round((elev_m + 10000.0) / 0.1).astype(np.uint32)
    r = (scaled >> 16) & 255
    g = (scaled >> 8) & 255
    b = scaled & 255
    rgba = np.dstack([
        r.astype(np.uint8),
        g.astype(np.uint8),
        b.astype(np.uint8),
        np.full_like(r, 255, dtype=np.uint8),
    ])

    image = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    ny, nx = elev_m.shape
    bounds = (float(lon[0]), float(lat[0]), float(lon[-1]), float(lat[-1]))
    return buf.read(), bounds, nx, ny


def create_app() -> Flask:
    app = Flask(__name__)

    data_path = resolve_data_path()
    ds = open_era5_dataset(data_path)
    z500_da = select_z500(ds)

    # Determine the time coordinate key once (prefer the indexable 'time')
    if "time" in z500_da.dims or "time" in z500_da.coords:
        time_coord = "time"
    elif "valid_time" in z500_da.coords:
        time_coord = "valid_time"
    else:
        raise KeyError("No time coordinate found (expected 'time' or 'valid_time')")

    # Freeze lat/lon for bounds; arrays are 1D if regular grid
    lat = z500_da.latitude.values if "latitude" in z500_da.coords else None
    lon = z500_da.longitude.values if "longitude" in z500_da.coords else None
    if lat is None or lon is None:
        raise KeyError("Expected 'latitude' and 'longitude' coordinates in dataset")

    @app.get("/gph/<datehour>")
    def gph(datehour: str):
        try:
            dt = parse_datehour(datehour)
        except ValueError:
            abort(400, description="Invalid datehour format")

        try:
            # Select nearest time slice, convert ERA5 z (m^2/s^2) to meters by dividing by g
            slice_da: xr.DataArray = z500_da.sel({time_coord: np.datetime64(dt)}, method="nearest") / STANDARD_GRAVITY_M_PER_S2
        except Exception as e:  # Selection failure or missing data
            abort(404, description=f"Data not found for requested time: {e}")

        # Ensure 2D array shaped (ny, nx)
        elev_m = slice_da.values.astype(np.float32)
        if elev_m.ndim != 2:
            abort(500, description="Unexpected data shape for z500 slice")

        png, bounds, nx, ny = encode_terrain_rgb_png(elev_m, lat, lon)

        headers = {
            "Access-Control-Allow-Origin": "*",
            "X-Bounds": ",".join(map(str, bounds)),
            "X-Size": f"{nx}x{ny}",
        }

        return Response(png, mimetype="image/png", headers=headers)

    return app


# When run directly: create the app and serve via Flask's dev server
app = create_app()

if __name__ == "__main__":
    # Default to port 8001 to avoid clashing with Next.js
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8001)))


