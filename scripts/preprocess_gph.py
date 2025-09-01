import io
import os
from datetime import datetime

import numpy as np
import xarray as xr
from PIL import Image


# Physical constants
STANDARD_GRAVITY_M_PER_S2: float = 9.80665


def resolve_paths(pressureLevel):
    """Return absolute paths for project root, data dir, grib path, and output dir."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    data_dir = os.path.join(root, "data")
    grib_path = os.path.join(data_dir, "data.grib")
    out_dir = os.path.join(data_dir, "gphImages", pressureLevel)
    os.makedirs(out_dir, exist_ok=True)
    return root, data_dir, grib_path, out_dir


def open_era5_dataset(path: str) -> xr.Dataset:
    if not os.path.exists(path):
        raise FileNotFoundError(f"GRIB file not found: {path}")
    return xr.open_dataset(path, engine="cfgrib")


def select_gph_z(era5_ds: xr.Dataset, pressureLevel) -> xr.DataArray:
    if "z" not in era5_ds.variables:
        raise KeyError("Variable 'z' (geopotential) not found in dataset")
    z_da = era5_ds["z"]
    dims = set(z_da.dims)
    if "isobaricInhPa" in dims:
        da = z_da.sel(isobaricInhPa=pressureLevel)
    elif "level" in dims:
        da = z_da.sel(level=pressureLevel)
    else:
        da = z_da
    if "latitude" in da.coords and da.latitude.ndim == 1 and np.any(np.diff(da.latitude.values) < 0):
        da = da.sortby("latitude")
    return da


def to_minus180_180(lon_1d: np.ndarray, elev_m: np.ndarray):
    lon = lon_1d.copy()
    nx = lon.size
    dlon = float(np.round((lon[1] - lon[0]) * 1e6) / 1e6)
    if lon.min() >= -180 and lon.max() <= 180:
        return lon, elev_m
    shift = int(np.round((-180.0 - lon[0]) / dlon)) % nx
    elev_rot = np.roll(elev_m, shift=shift, axis=1)
    lon_rot = lon + shift * dlon
    lon_rot = ((lon_rot + 180.0) % 360.0) - 180.0
    order = np.argsort(lon_rot)
    lon_sorted = lon_rot[order]
    elev_sorted = elev_rot[:, order]
    return lon_sorted, elev_sorted


def encode_terrain_rgb_png(elev_m: np.ndarray, lat: np.ndarray, lon: np.ndarray):
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
    bounds = (min_lon, min_lat, max_lon, max_lat)
    return buf.read(), bounds, nx, ny


def main():
    pressureLevel = 500
    grib_path = "."
    out_dir = "../data/gphImages/{pressureLevel}"
    # _, _, _, out_dir = resolve_paths(pressureLevel)

    ds = open_era5_dataset(grib_path)
    gphZ_data = select_gph_z(ds, pressureLevel)

    if "time" in gphZ_data.dims or "time" in gphZ_data.coords:
        time_coord = "time"
    elif "valid_time" in gphZ_data.coords:
        time_coord = "valid_time"
    else:
        raise KeyError("No time coordinate found (expected 'time' or 'valid_time')")

    lat = gphZ_data.latitude.values
    lon = gphZ_data.longitude.values

    times = gphZ_data[time_coord].values
    t0 = np.datetime_as_string(times[0], unit="h")
    tN = np.datetime_as_string(times[-1], unit="h")
    print(f"Dataset time range: {t0} .. {tN}")

    expected_start = datetime.strptime("2017080100", "%Y%m%d%H")
    expected_end = datetime.strptime("2017093023", "%Y%m%d%H")
    start_dt = np.datetime64(times[0]).astype("datetime64[h]")
    end_dt = np.datetime64(times[-1]).astype("datetime64[h]")
    covers_expected = (start_dt <= np.datetime64(expected_start)) and (end_dt >= np.datetime64(expected_end))
    print(f"Covers expected 2017080100..2017093023: {covers_expected}")

    total = len(times)
    for idx, t in enumerate(times, start=1):
        # Format YYYYMMDDHH
        ts = np.datetime_as_string(t, unit="h").replace("-", "").replace(":", "").replace("T", "")
        png_path = os.path.join(out_dir, f"gph_{ts}.png")
        if os.path.exists(png_path):
            if idx % 100 == 0:
                print(f"[{idx}/{total}] Exists, skipping: {os.path.basename(png_path)}")
            continue

        slice_da = (gphZ_data.sel({time_coord: np.datetime64(t)}) / STANDARD_GRAVITY_M_PER_S2)
        elev_m = slice_da.values.astype(np.float32)

        lon_fixed, elev_fixed = to_minus180_180(lon, elev_m)
        lat_work = lat.copy()
        if lat_work[0] < lat_work[-1]:
            elev_fixed = elev_fixed[::-1, :]
            lat_work = lat_work[::-1]

        png_bytes, _, _, _ = encode_terrain_rgb_png(elev_fixed, lat_work, lon_fixed)
        with open(png_path, "wb") as f:
            f.write(png_bytes)

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] Wrote {os.path.basename(png_path)}")


if __name__ == "__main__":
    main()


