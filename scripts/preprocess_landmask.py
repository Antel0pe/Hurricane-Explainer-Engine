import io
import os

import numpy as np
import xarray as xr
from PIL import Image


def resolve_paths():
    """Return absolute paths for project root, data dir, lsm path, and output image path."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    data_dir = os.path.join(root, "data")
    lsm_path = os.path.join(data_dir, "lsm.grib")
    out_path = os.path.join(data_dir, "landMask.png")
    os.makedirs(data_dir, exist_ok=True)
    return root, data_dir, lsm_path, out_path


def open_era5_dataset(path: str) -> xr.Dataset:
    if not os.path.exists(path):
        raise FileNotFoundError(f"GRIB file not found: {path}")
    return xr.open_dataset(path, engine="cfgrib")


def select_lsm(era5_ds: xr.Dataset) -> xr.DataArray:
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


def to_minus180_180(lon_1d: np.ndarray, arr2d: np.ndarray):
    lon = lon_1d.copy()
    nx = lon.size
    dlon = float(np.round((lon[1] - lon[0]) * 1e6) / 1e6)
    if lon.min() >= -180 and lon.max() <= 180:
        return lon, arr2d
    shift = int(np.round((-180.0 - lon[0]) / dlon)) % nx
    arr_rot = np.roll(arr2d, shift=shift, axis=1)
    lon_rot = lon + shift * dlon
    lon_rot = ((lon_rot + 180.0) % 360.0) - 180.0
    order = np.argsort(lon_rot)
    lon_sorted = lon_rot[order]
    arr_sorted = arr_rot[:, order]
    return lon_sorted, arr_sorted


def encode_landmask_png(mask_land: np.ndarray, lat: np.ndarray, lon: np.ndarray):
    # mask_land True for land (black), False for sea (white)
    sea = (~mask_land).astype(np.uint8) * 255
    rgba = np.dstack([
        sea,
        sea,
        sea,
        np.full_like(sea, 255, dtype=np.uint8),
    ])
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


def main():
    _, _, lsm_path, out_path = resolve_paths()

    ds = open_era5_dataset(lsm_path)
    lsm_da = select_lsm(ds)

    lat = lsm_da.latitude.values
    lon = lsm_da.longitude.values

    lsm_vals = lsm_da.values.astype(np.float32)
    mask_land = lsm_vals > 0.5

    lon_fixed, mask_fixed = to_minus180_180(lon, mask_land.astype(np.float32))

    lat_work = lat.copy()
    if lat_work[0] < lat_work[-1]:
        mask_fixed = mask_fixed[::-1, :]
        lat_work = lat_work[::-1]

    mask_fixed_bool = mask_fixed >= 0.5
    png_bytes, _, _, _ = encode_landmask_png(mask_fixed_bool, lat_work, lon_fixed)

    with open(out_path, "wb") as f:
        f.write(png_bytes)
    print(f"Wrote land mask → {out_path}")


if __name__ == "__main__":
    main()


