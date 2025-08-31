import io
import os
from datetime import datetime
from typing import Tuple

import numpy as np
import xarray as xr
from PIL import Image
from flask import Flask, Response, abort
from flask_cors import CORS


# Physical constants
STANDARD_GRAVITY_M_PER_S2: float = 9.80665


def resolve_data_path() -> str:
    """Resolve absolute path to data/data.grib relative to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    data_path = os.path.join(root, "data", "data.grib")
    return data_path


def resolve_gph_image_dir() -> str:
    """Resolve absolute path to data/gphImages relative to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    out_dir = os.path.join(root, "data", "gphImages")
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


def resolve_uv_image_dir() -> str:
    """Resolve absolute path to data/uv_images relative to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    out_dir = os.path.join(root, "data", "uv_images")
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


def resolve_lsm_path() -> str:
    """Resolve absolute path to data/lsm.grib relative to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    data_path = os.path.join(root, "data", "lsm.grib")
    return data_path


def resolve_landmask_image_path() -> str:
    """Resolve absolute path to data/landMask.png relative to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    out_path = os.path.join(root, "data", "landMask.png")
    out_dir = os.path.dirname(out_path)
    os.makedirs(out_dir, exist_ok=True)
    return out_path


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


def select_lsm(era5_ds: xr.Dataset) -> xr.DataArray:
    """Select land-sea mask (lsm) from ERA5 dataset and reduce to 2D lat-lon.

    Any extra dims (e.g., time, step) are reduced by taking the first index.
    Ensures latitude increases south->north.
    """
    if "lsm" not in era5_ds.variables:
        raise KeyError("Variable 'lsm' (land-sea mask) not found in dataset")

    da = era5_ds["lsm"]
    # Reduce non-spatial dims to first index
    for dim in list(da.dims):
        if dim not in {"latitude", "longitude"}:
            da = da.isel({dim: 0})

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
    min_lon = float(lon[0]) if lon[0] <= lon[-1] else float(lon[-1])
    max_lon = float(lon[-1]) if lon[-1] >= lon[0] else float(lon[0])
    min_lat = float(lat[0]) if lat[0] <= lat[-1] else float(lat[-1])
    max_lat = float(lat[-1]) if lat[-1] >= lat[0] else float(lat[0])
    print("--------------------------------")
    print(lat)
    print(lon)
    print(min_lon, min_lat, max_lon, max_lat)
    bounds = (min_lon, min_lat, max_lon, max_lat)
    return buf.read(), bounds, nx, ny


def to_minus180_180(lon_1d: np.ndarray, elev_m: np.ndarray):
    """
    Convert a (ny, nx) elev grid with lon in [0,360) to [-180,180),
    rolling columns so longitudes align with the new axis.
    Returns lon_new (nx,), elev_new (ny,nx)
    """
    lon = lon_1d.copy()
    nx = lon.size
    # Detect spacing
    dlon = float(np.round((lon[1] - lon[0]) * 1e6) / 1e6)
    # If already -180..180, do nothing
    if lon.min() >= -180 and lon.max() <= 180:
        return lon, elev_m

    # How many columns to roll so that -180 is at index 0
    # Typical ERA5: lon[0]=0, dlon=0.25 -> shift=+720
    shift = int(np.round((-180.0 - lon[0]) / dlon)) % nx

    elev_rot = np.roll(elev_m, shift=shift, axis=1)
    lon_rot = lon + shift * dlon
    # Wrap into [-180,180)
    lon_rot = ((lon_rot + 180.0) % 360.0) - 180.0

    # Ensure strictly increasing lon
    order = np.argsort(lon_rot)
    lon_sorted = lon_rot[order]
    elev_sorted = elev_rot[:, order]
    return lon_sorted, elev_sorted


def encode_landmask_png(mask_land: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> Tuple[bytes, Tuple[float, float, float, float], int, int]:
    """Encode a land mask into a black/white PNG with bounds.

    mask_land is True for land (black), False for sea (white).
    Returns: (png_bytes, bounds[minLon,minLat,maxLon,maxLat], nx, ny)
    """
    sea = (~mask_land).astype(np.uint8) * 255
    r = sea
    g = sea
    b = sea
    a = np.full_like(sea, 255, dtype=np.uint8)
    rgba = np.dstack([r, g, b, a])

    image = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    ny, nx = mask_land.shape
    min_lon = float(lon[0]) if lon[0] <= lon[-1] else float(lon[-1])
    max_lon = float(lon[-1]) if lon[-1] >= lon[0] else float(lon[0])
    min_lat = float(lat[0]) if lat[0] <= lat[-1] else float(lat[-1])
    max_lat = float(lat[-1]) if lat[-1] >= lat[0] else float(lat[0])
    bounds = (min_lon, min_lat, max_lon, max_lat)
    return buf.read(), bounds, nx, ny


def create_app() -> Flask:
    app = Flask(__name__)
    # Enable CORS for all origins and expose custom headers used by the client
    CORS(app, resources={r"/*": {"origins": "*"}}, expose_headers=["X-Bounds", "X-Size"]) 

    # data_path = resolve_data_path()
    # ds = open_era5_dataset(data_path)
    # z500_da = select_z500(ds)

    # # Determine the time coordinate key once (prefer the indexable 'time')
    # if "time" in z500_da.dims or "time" in z500_da.coords:
    #     time_coord = "time"
    # elif "valid_time" in z500_da.coords:
    #     time_coord = "valid_time"
    # else:
    #     raise KeyError("No time coordinate found (expected 'time' or 'valid_time')")

    # # Freeze lat/lon for bounds; arrays are 1D if regular grid
    # lat = z500_da.latitude.values if "latitude" in z500_da.coords else None
    # lon = z500_da.longitude.values if "longitude" in z500_da.coords else None
    # if lat is None or lon is None:
    #     raise KeyError("Expected 'latitude' and 'longitude' coordinates in dataset")
    lat = np.arange(90, -90.0001, -0.25)
    lon = np.arange(0, 360, 0.25)

    @app.get("/gph/<datehour>")
    def gph(datehour: str):
        try:
            dt = parse_datehour(datehour)
        except ValueError:
            abort(400, description="Invalid datehour format")

        # If a preprocessed image exists, serve it directly with proper headers
        ts = dt.strftime("%Y%m%d%H")
        image_dir = resolve_gph_image_dir()
        image_path = os.path.join(image_dir, f"gph_{ts}.png")

        if os.path.exists(image_path):
            # Compute bounds and size consistent with on-the-fly processing
            # Use dataset lat/lon to determine bounds and dimensions
            elev_stub = np.zeros((lat.size, lon.size), dtype=np.float32)
            lon_fixed, _ = to_minus180_180(lon, elev_stub)

            lat_work = lat.copy()
            if lat_work[0] < lat_work[-1]:
                lat_work = lat_work[::-1]

            nx = lon_fixed.size
            ny = lat_work.size
            min_lon = float(lon_fixed[0]) if lon_fixed[0] <= lon_fixed[-1] else float(lon_fixed[-1])
            max_lon = float(lon_fixed[-1]) if lon_fixed[-1] >= lon_fixed[0] else float(lon_fixed[0])
            min_lat = float(lat_work[0]) if lat_work[0] <= lat_work[-1] else float(lat_work[-1])
            max_lat = float(lat_work[-1]) if lat_work[-1] >= lat_work[0] else float(lat_work[0])
            bounds = (min_lon, min_lat, max_lon, max_lat)

            with open(image_path, "rb") as f:
                data = f.read()
            resp = Response(data, mimetype="image/png")
            resp.headers["X-Bounds"] = ",".join(map(str, bounds))
            resp.headers["X-Size"] = f"{nx}x{ny}"
            return resp

        try:
            # Select nearest time slice, convert ERA5 z (m^2/s^2) to meters by dividing by g
            slice_da: xr.DataArray = z500_da.sel({time_coord: np.datetime64(dt)}, method="nearest") / STANDARD_GRAVITY_M_PER_S2
        except Exception as e:  # Selection failure or missing data
            abort(404, description=f"Data not found for requested time: {e}")

        # Ensure 2D array shaped (ny, nx)
        elev_m = slice_da.values.astype(np.float32)
        if elev_m.ndim != 2:
            abort(500, description="Unexpected data shape for z500 slice")
            
        print(lat)
        print(lon)

        # Normalize lon to [-180, 180) and roll columns to match
        lon_fixed, elev_fixed = to_minus180_180(lon, elev_m)
        print("--------------------------------")
        print(lon_fixed)

        # Ensure image rows go north (top) -> south (bottom)
        lat_work = lat.copy()
        if lat_work[0] < lat_work[-1]:
            elev_fixed = elev_fixed[::-1, :]
            lat_work = lat_work[::-1]

        png, bounds, nx, ny = encode_terrain_rgb_png(elev_fixed, lat_work, lon_fixed)

        # Expose custom headers so browsers can read them from JS
        resp = Response(png, mimetype="image/png")
        resp.headers["X-Bounds"] = ",".join(map(str, bounds))
        resp.headers["X-Size"] = f"{nx}x{ny}"
        return resp

    @app.get("/uv/<datehour>")
    def uv(datehour: str):
        """Serve preprocessed UV image (U->R, V->G) for given datehour if present.

        If the image is missing, return 404 with 'image doesn't exist'.
        """
        try:
            dt = parse_datehour(datehour)
        except ValueError:
            abort(400, description="Invalid datehour format")

        ts = dt.strftime("%Y%m%d%H")
        image_dir = resolve_uv_image_dir()
        image_path = os.path.join(image_dir, f"uv_{ts}.png")

        if not os.path.exists(image_path):
            abort(404, description="image doesn't exist")

        # Compute bounds and size based on dataset lat/lon (same as gph route)
        elev_stub = np.zeros((lat.size, lon.size), dtype=np.float32)
        lon_fixed, _ = to_minus180_180(lon, elev_stub)

        lat_work = lat.copy()
        if lat_work[0] < lat_work[-1]:
            lat_work = lat_work[::-1]

        nx = lon_fixed.size
        ny = lat_work.size
        min_lon = float(lon_fixed[0]) if lon_fixed[0] <= lon_fixed[-1] else float(lon_fixed[-1])
        max_lon = float(lon_fixed[-1]) if lon_fixed[-1] >= lon_fixed[0] else float(lon_fixed[0])
        min_lat = float(lat_work[0]) if lat_work[0] <= lat_work[-1] else float(lat_work[-1])
        max_lat = float(lat_work[-1]) if lat_work[-1] >= lat_work[0] else float(lat_work[0])
        bounds = (min_lon, min_lat, max_lon, max_lat)

        with open(image_path, "rb") as f:
            data = f.read()
        resp = Response(data, mimetype="image/png")
        resp.headers["X-Bounds"] = ",".join(map(str, bounds))
        resp.headers["X-Size"] = f"{nx}x{ny}"
        return resp

    @app.get("/landMask")
    def land_mask():
        """Return a global land/sea mask as black/white PNG with bounds headers.

        - Land: black (0,0,0)
        - Sea: white (255,255,255)
        Uses ERA5 land-sea mask from data/lsm.grib.
        """
        image_path = resolve_landmask_image_path()
        lsm_path = resolve_lsm_path()

        # If cached image exists, return it with computed headers using z500 lat/lon
        if os.path.exists(image_path):
            elev_stub = np.zeros((lat.size, lon.size), dtype=np.float32)
            lon_fixed, _ = to_minus180_180(lon, elev_stub)

            lat_work = lat.copy()
            if lat_work[0] < lat_work[-1]:
                lat_work = lat_work[::-1]

            nx = lon_fixed.size
            ny = lat_work.size
            min_lon = float(lon_fixed[0]) if lon_fixed[0] <= lon_fixed[-1] else float(lon_fixed[-1])
            max_lon = float(lon_fixed[-1]) if lon_fixed[-1] >= lon_fixed[0] else float(lon_fixed[0])
            min_lat = float(lat_work[0]) if lat_work[0] <= lat_work[-1] else float(lat_work[-1])
            max_lat = float(lat_work[-1]) if lat_work[-1] >= lat_work[0] else float(lat_work[0])
            bounds = (min_lon, min_lat, max_lon, max_lat)

            with open(image_path, "rb") as f:
                data = f.read()
            resp = Response(data, mimetype="image/png")
            resp.headers["X-Bounds"] = ",".join(map(str, bounds))
            resp.headers["X-Size"] = f"{nx}x{ny}"
            return resp

        # Otherwise, generate from source lsm.grib
        try:
            lsm_ds = open_era5_dataset(lsm_path)
            lsm_da = select_lsm(lsm_ds)
        except Exception as e:
            abort(500, description=f"Unable to open land mask source (data/lsm.grib): {e}")

        lat_lsm = lsm_da.latitude.values if "latitude" in lsm_da.coords else None
        lon_lsm = lsm_da.longitude.values if "longitude" in lsm_da.coords else None
        if lat_lsm is None or lon_lsm is None:
            abort(500, description="Expected 'latitude' and 'longitude' in LSM dataset")

        lsm_vals = lsm_da.values.astype(np.float32)
        # ERA5 LSM: 1 over land, 0 over sea. Threshold at > 0.5
        mask_land = lsm_vals > 0.5

        lon_fixed, mask_fixed = to_minus180_180(lon_lsm, mask_land.astype(np.float32))

        lat_work = lat_lsm.copy()
        if lat_work[0] < lat_work[-1]:
            mask_fixed = mask_fixed[::-1, :]
            lat_work = lat_work[::-1]

        mask_fixed_bool = mask_fixed >= 0.5
        png, bounds, nx, ny = encode_landmask_png(mask_fixed_bool, lat_work, lon_fixed)

        with open(image_path, "wb") as f:
            f.write(png)

        resp = Response(png, mimetype="image/png")
        resp.headers["X-Bounds"] = ",".join(map(str, bounds))
        resp.headers["X-Size"] = f"{nx}x{ny}"
        return resp

    return app


# When run directly: create the app and serve via Flask's dev server
app = create_app()

if __name__ == "__main__":
    # Default to port 8001 to avoid clashing with Next.js
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8001)))


