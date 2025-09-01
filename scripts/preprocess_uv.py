import io
import os
import argparse
from datetime import datetime

import numpy as np
import xarray as xr
from PIL import Image


def resolve_paths():
    """Return absolute paths for project root, data dir, uv grib path, and output dir."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    data_dir = os.path.join(root, "data")
    grib_path = os.path.join(data_dir, "500hpa_uv_wind.grib")
    out_dir = os.path.join(data_dir, "uv_images")
    os.makedirs(out_dir, exist_ok=True)
    return root, data_dir, grib_path, out_dir


def open_dataset(path: str) -> xr.Dataset:
    if not os.path.exists(path):
        raise FileNotFoundError(f"UV GRIB file not found: {path}")
    # cfgrib engine handles GRIB; .grib path provided by user
    return xr.open_dataset(path, engine="cfgrib")


def select_level_component(ds: xr.Dataset, var_name: str, level_hpa: int) -> xr.DataArray:
    if var_name not in ds.variables:
        raise KeyError(f"Variable '{var_name}' not found in dataset")
    da = ds[var_name]
    dims = set(da.dims)
    if "isobaricInhPa" in dims:
        da = da.sel(isobaricInhPa=level_hpa)
    elif "level" in dims:
        da = da.sel(level=level_hpa)
    # Ensure latitude increases south->north
    if "latitude" in da.coords and da.latitude.ndim == 1 and np.any(np.diff(da.latitude.values) < 0):
        da = da.sortby("latitude")
    return da


def to_minus180_180(lon_1d: np.ndarray, field_2d: np.ndarray):
    """Convert lon from [0,360) to [-180,180) and roll columns accordingly."""
    lon = lon_1d.copy()
    nx = lon.size
    if nx < 2:
        return lon, field_2d
    dlon = float(np.round((lon[1] - lon[0]) * 1e6) / 1e6)
    if lon.min() >= -180 and lon.max() <= 180:
        return lon, field_2d
    shift = int(np.round((-180.0 - lon[0]) / dlon)) % nx
    rolled = np.roll(field_2d, shift=shift, axis=1)
    lon_rot = lon + shift * dlon
    lon_rot = ((lon_rot + 180.0) % 360.0) - 180.0
    order = np.argsort(lon_rot)
    lon_sorted = lon_rot[order]
    field_sorted = rolled[:, order]
    return lon_sorted, field_sorted


def scale_to_255(a: np.ndarray) -> np.ndarray:
    """Scale array to uint8 [0,255] using per-slice min-max. NaNs -> 0.

    If the slice is constant or empty, return mid-gray (127) where finite, else 0.
    """
    a = a.astype(np.float32)
    mask = np.isfinite(a)
    if not np.any(mask):
        return np.zeros_like(a, dtype=np.uint8)
    
    # TO DO: this is inconsistent scale across multiple different hours
    # if there is really high wind speed then every other wind will appear relatively slower
    # there should be a fixed scale here for accurate comparison
    vmin = float(np.min(a[mask]))
    vmax = float(np.max(a[mask]))
    if vmax <= vmin:
        out = np.full_like(a, 127, dtype=np.uint8)
        out[~mask] = 0
        return out
    scaled = (a - vmin) / (vmax - vmin)
    scaled = np.clip(scaled * 255.0, 0.0, 255.0)
    out = scaled.astype(np.uint8)
    out[~mask] = 0
    return out


def encode_uv_rg_png(u: np.ndarray, v: np.ndarray) -> bytes:
    """Encode two fields into PNG with U in red and V in green; B=0, A=255."""
    r = scale_to_255(u)
    g = scale_to_255(v)
    b = np.zeros_like(r, dtype=np.uint8)
    a = np.full_like(r, 255, dtype=np.uint8)
    rgba = np.dstack([r, g, b, a])
    image = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def main():
    pressureLevel = 500
    grib_path = "."
    out_dir = "../data/uv_images/{pressureLevel}"
    # _, _, grib_path, out_dir = resolve_paths()
    ds = open_dataset(grib_path)

    # Select 500 hPa components
    u_da = select_level_component(ds, "u", pressureLevel)
    v_da = select_level_component(ds, "v", pressureLevel)

    # Determine time coordinate
    if "time" in u_da.dims or "time" in u_da.coords:
        time_coord = "time"
    elif "valid_time" in u_da.coords:
        time_coord = "valid_time"
    else:
        raise KeyError("No time coordinate found (expected 'time' or 'valid_time')")

    # Coordinates
    lat = u_da.latitude.values
    lon = u_da.longitude.values

    # Normalize lon ordering for bounds/consistency and lat orientation (north->south rows)
    # We'll apply the same transforms to each time slice
    times = u_da[time_coord].values
    if times.size == 0:
        print("No time steps found in dataset")
        return

    # --- Happy path: fixed date window, hourly, inclusive ---
    start_np = np.datetime64("2017-08-01T00")
    end_np   = np.datetime64("2017-09-30T23")
    mask = (times >= start_np) & (times <= end_np)
    selected_times = times[mask]
    if selected_times.size == 0:
        t0 = np.datetime_as_string(times[0], unit="h")
        tN = np.datetime_as_string(times[-1], unit="h")
        print(f"No times within happy-path window (2017-08-01T00 .. 2017-09-30T23). "
              f"Dataset range is {t0} .. {tN}")
        return

    t0 = np.datetime_as_string(times[0], unit="h")
    tN = np.datetime_as_string(times[-1], unit="h")
    print(f"Dataset time range: {t0} .. {tN}")
    total = selected_times.size

    # Precompute lon/lat transform for bounds and orientation
    lon_fixed, _ = to_minus180_180(lon, np.zeros((lat.size, lon.size), dtype=np.float32))
    lat_work = lat.copy()
    flip_lat = False
    if lat_work[0] < lat_work[-1]:
        lat_work = lat_work[::-1]
        flip_lat = True

    for idx, t in enumerate(selected_times, start=1):
        ts = np.datetime_as_string(t, unit="h").replace("-", "").replace(":", "").replace("T", "")
        png_path = os.path.join(out_dir, f"uv_{ts}.png")

        # Extract slices
        u_sl = u_da.sel({time_coord: np.datetime64(t)})
        v_sl = v_da.sel({time_coord: np.datetime64(t)})
        u_vals = u_sl.values.astype(np.float32)
        v_vals = v_sl.values.astype(np.float32)

        # Ensure 2D and consistent orientation
        if u_vals.ndim != 2 or v_vals.ndim != 2:
            raise RuntimeError("Unexpected data shape for UV slice; expected 2D lat-lon")

        lon_u, u_fixed = to_minus180_180(lon, u_vals)
        lon_v, v_fixed = to_minus180_180(lon, v_vals)
        # Sanity: both lon transforms should be identical
        if lon_u.shape != lon_fixed.shape or not np.allclose(lon_u, lon_fixed):
            lon_fixed = lon_u
        if flip_lat:
            u_fixed = u_fixed[::-1, :]
            v_fixed = v_fixed[::-1, :]

        png_bytes = encode_uv_rg_png(u_fixed, v_fixed)

        with open(png_path, "wb") as f:
            f.write(png_bytes)

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] Wrote {os.path.basename(png_path)}")


if __name__ == "__main__":
    main()


