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
    grib_path = os.path.join(data_dir, "data.grib")  # adjust if you use a different filename
    out_dir = os.path.join(data_dir, "cloudImages_rgb_lmh")
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
    # sometimes cfgrib exposes "shortName" only; try attribute lookup
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


def select_lmh_cloud(ds: xr.Dataset):
    """
    Return tuple (lcc, mcc, hcc) as DataArrays aligned on time/lat/lon.
    Expected units: 0..1 (fraction). We clip to [0,1].
    """
    lcc = get_var(ds, ["lcc", "low_cloud_cover", "lccs"])
    mcc = get_var(ds, ["mcc", "medium_cloud_cover", "mccs"])
    hcc = get_var(ds, ["hcc", "high_cloud_cover", "hccs"])

    # Ensure consistent latitude orientation (north->south expected by many pipelines)
    def fix_lat(da: xr.DataArray) -> xr.DataArray:
        if "latitude" in da.coords and da.latitude.ndim == 1 and np.any(np.diff(da.latitude.values) < 0):
            return da.sortby("latitude")
        return da

    lcc = fix_lat(lcc)
    mcc = fix_lat(mcc)
    hcc = fix_lat(hcc)

    # Identify time coordinate
    time_coord = "time" if "time" in lcc.coords else ("valid_time" if "valid_time" in lcc.coords else None)
    if time_coord is None:
        raise KeyError("No time coordinate found (expected 'time' or 'valid_time').")

    # Align by reindex_like in case of slight metadata differences
    mcc = mcc.reindex_like(lcc, method=None, copy=False)
    hcc = hcc.reindex_like(lcc, method=None, copy=False)

    return lcc.clip(0.0, 1.0), mcc.clip(0.0, 1.0), hcc.clip(0.0, 1.0), time_coord


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


def encode_lmh_rgb_png(lcc2d: np.ndarray, mcc2d: np.ndarray, hcc2d: np.ndarray):
    """
    Inputs are 2D arrays in 0..1. Outputs an opaque RGBA PNG byte buffer where:
    R = low, G = medium, B = high.
    """
    # NaNs -> 0
    l = np.nan_to_num(lcc2d, nan=0.0)
    m = np.nan_to_num(mcc2d, nan=0.0)
    h = np.nan_to_num(hcc2d, nan=0.0)

    # scale to 0..255 (round, then clip)
    def to_u8(x):
        y = np.rint(np.clip(x, 0.0, 1.0) * 255.0).astype(np.uint8)
        return y

    r = to_u8(l)
    g = to_u8(m)
    b = to_u8(h)
    a = np.full_like(r, 255, dtype=np.uint8)

    rgba = np.dstack([r, g, b, a])
    image = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def main():
    # Adjust these if you prefer hard-coded paths:
    grib_path = "/mnt/c/Users/dmmsp/Downloads/data.grib"
    out_dir   = "/mnt/c/Users/dmmsp/Projects/Hurricane-Explainer-Engine/data/cloudCover"
    # _, _, grib_path, out_dir = resolve_paths()

    ds = open_era5_dataset(grib_path)
    lcc, mcc, hcc, time_coord = select_lmh_cloud(ds)

    lat = lcc.latitude.values
    lon = lcc.longitude.values

    times = lcc[time_coord].values
    t0 = np.datetime_as_string(times[0], unit="h")
    tN = np.datetime_as_string(times[-1], unit="h")
    print(f"Dataset time range: {t0} .. {tN}")

    # Optional sanity check for Aug 1 2017 00 to Sep 30 2017 23
    try:
        expected_start = datetime.strptime("2017080100", "%Y%m%d%H")
        expected_end = datetime.strptime("2017093023", "%Y%m%d%H")
        start_dt = np.datetime64(times[0]).astype("datetime64[h]")
        end_dt = np.datetime64(times[-1]).astype("datetime64[h]")
        covers_expected = (start_dt <= np.datetime64(expected_start)) and (end_dt >= np.datetime64(expected_end))
        print(f"Covers expected 2017080100..2017093023: {covers_expected}")
    except Exception:
        pass

    # Ensure latitude descending (north->south) for output consistency
    lat_work = lat.copy()
    flip_lat = False
    if lat_work[0] < lat_work[-1]:
        flip_lat = True
        lat_work = lat_work[::-1]

    total = len(times)
    for idx, t in enumerate(times, start=1):
        ts = np.datetime_as_string(t, unit="h").replace("-", "").replace(":", "").replace("T", "")
        png_path = os.path.join(out_dir, f"clouds_lmh_{ts}.png")

        l2d = lcc.sel({time_coord: np.datetime64(t)}).values.astype(np.float32)
        m2d = mcc.sel({time_coord: np.datetime64(t)}).values.astype(np.float32)
        h2d = hcc.sel({time_coord: np.datetime64(t)}).values.astype(np.float32)

        if flip_lat:
            l2d = l2d[::-1, :]
            m2d = m2d[::-1, :]
            h2d = h2d[::-1, :]

        # Shift longitude to [-180,180] and apply same roll/order to all three channels
        lon_fixed, l2d = to_minus180_180(lon, l2d)
        _,         m2d = to_minus180_180(lon, m2d)
        _,         h2d = to_minus180_180(lon, h2d)

        png_bytes = encode_lmh_rgb_png(l2d, m2d, h2d)
        with open(png_path, "wb") as f:
            f.write(png_bytes)

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] Wrote {os.path.basename(png_path)}")


if __name__ == "__main__":
    main()
