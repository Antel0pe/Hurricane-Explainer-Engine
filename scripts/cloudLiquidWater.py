import io
import os
from datetime import datetime

import numpy as np
import xarray as xr
from PIL import Image


def resolve_paths():
    """Return absolute paths for project root, data dir, grib path, and output dir."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    data_dir = os.path.join(root, "data")
    grib_path = os.path.join(data_dir, "data.grib")
    out_dir = os.path.join(data_dir, "cloudImages_liq_ice")
    os.makedirs(out_dir, exist_ok=True)
    return root, data_dir, grib_path, out_dir


def open_era5_dataset(path: str) -> xr.Dataset:
    if not os.path.exists(path):
        raise FileNotFoundError(f"GRIB file not found: {path}")
    return xr.open_dataset(path, engine="cfgrib")


def get_var(ds: xr.Dataset, preferred_names):
    for name in preferred_names:
        if name in ds.variables:
            return ds[name]
    for v in ds.variables:
        var = ds[v]
        if any(getattr(var, "shortName", "") == n for n in preferred_names):
            return var
        if any(getattr(var, "name", "") == n for n in preferred_names):
            return var
        if any(getattr(var, "long_name", "") == n for n in preferred_names):
            return var
        if any(getattr(var, "standard_name", "") == n for n in preferred_names):
            return var
    raise KeyError(f"None of {preferred_names} found in dataset. Present: {list(ds.variables)}")


def select_liq_ice(ds: xr.Dataset):
    """
    Return (tclw, tciw) clipped to [0,1] and [0,0.3], aligned on time/lat/lon.
    """
    tclw = get_var(ds, ["tclw", "total_column_cloud_liquid_water"])
    tciw = get_var(ds, ["tciw", "total_column_cloud_ice_water"])

    def fix_lat(da: xr.DataArray) -> xr.DataArray:
        if "latitude" in da.coords and da.latitude.ndim == 1 and np.any(np.diff(da.latitude.values) < 0):
            return da.sortby("latitude")
        return da

    tclw = fix_lat(tclw)
    tciw = fix_lat(tciw)

    time_coord = "time" if "time" in tclw.coords else ("valid_time" if "valid_time" in tclw.coords else None)
    if time_coord is None:
        raise KeyError("No time coordinate found (expected 'time' or 'valid_time').")

    tciw = tciw.reindex_like(tclw, method=None, copy=False)

    return tclw.clip(0.0, 1.0), tciw.clip(0.0, 0.3), time_coord


def to_minus180_180(lon_1d: np.ndarray, arr: np.ndarray):
    """Shift longitudes from [0,360] to [-180,180] while rolling array columns accordingly."""
    lon = lon_1d.copy()
    nx = lon.size
    dlon = float(np.round((lon[1] - lon[0]) * 1e6) / 1e6)
    if lon.min() >= -180 and lon.max() <= 180:
        return lon, arr
    shift = int(np.round((-180.0 - lon[0]) / dlon)) % nx
    arr_rot = np.roll(arr, shift=shift, axis=1)
    lon_rot = lon + shift * dlon
    lon_rot = ((lon_rot + 180.0) % 360.0) - 180.0
    order = np.argsort(lon_rot)
    return lon_rot[order], arr_rot[:, order]


def encode_liq_ice_png(tclw2d: np.ndarray, tciw2d: np.ndarray):
    """
    Encode as RGBA:
      R = liquid (0–1)
      G = ice (0–0.3)
    """
    L = np.nan_to_num(tclw2d, nan=0.0)
    I = np.nan_to_num(tciw2d, nan=0.0)

    def to_u8(x, scale_max):
        return np.rint(np.clip(x / scale_max, 0.0, 1.0) * 255.0).astype(np.uint8)

    r = to_u8(L, 1.0)
    g = to_u8(I, 0.3)
    b = np.zeros_like(r, dtype=np.uint8)
    a = np.full_like(r, 255, dtype=np.uint8)

    rgba = np.dstack([r, g, b, a])
    image = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def main():
    grib_path = "/mnt/c/Users/dmmsp/Downloads/cloudLiquidWaterAndIce.grib"
    out_dir   = "/mnt/c/Users/dmmsp/Projects/Hurricane-Explainer-Engine/data/cloudLiquidAndIce"
    # _, _, grib_path, out_dir = resolve_paths()

    ds = open_era5_dataset(grib_path)
    tclw, tciw, time_coord = select_liq_ice(ds)

    lat = tclw.latitude.values
    lon = tclw.longitude.values
    times = tclw[time_coord].values

    print(f"Dataset time range: {np.datetime_as_string(times[0], unit='h')} .. {np.datetime_as_string(times[-1], unit='h')}")

    lat_work = lat.copy()
    flip_lat = lat_work[0] < lat_work[-1]
    if flip_lat:
        lat_work = lat_work[::-1]

    total = len(times)
    for idx, t in enumerate(times, start=1):
        ts = np.datetime_as_string(t, unit="h").replace("-", "").replace(":", "").replace("T", "")
        png_path = os.path.join(out_dir, f"clouds_liq-ice_{ts}.png")

        L2d = tclw.sel({time_coord: np.datetime64(t)}).values.astype(np.float32)
        I2d = tciw.sel({time_coord: np.datetime64(t)}).values.astype(np.float32)

        if flip_lat:
            L2d = L2d[::-1, :]
            I2d = I2d[::-1, :]

        lon_fixed, L2d = to_minus180_180(lon, L2d)
        _,         I2d = to_minus180_180(lon, I2d)

        png_bytes = encode_liq_ice_png(L2d, I2d)
        with open(png_path, "wb") as f:
            f.write(png_bytes)

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] Wrote {os.path.basename(png_path)}")


if __name__ == "__main__":
    main()
