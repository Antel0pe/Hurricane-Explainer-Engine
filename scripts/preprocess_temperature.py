import io
import os
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


# ---- Fixed-range scaler ----
def scale_fixed_range(a: np.ndarray, vmin: float, vmax: float) -> np.ndarray:
    """
    Linearly scale array to uint8 [0,255] using a fixed [vmin, vmax] range.
    NaNs -> 0. Values outside the range are clipped.
    """
    a = a.astype(np.float32)
    out = np.zeros_like(a, dtype=np.uint8)
    if not np.isfinite(vmin) or not np.isfinite(vmax) or vmax <= vmin:
        return out
    scaled = (a - vmin) / (vmax - vmin)
    scaled = np.clip(scaled * 255.0, 0.0, 255.0)
    out = scaled.astype(np.uint8)
    out[~np.isfinite(a)] = 0
    return out


# ---- Temperature fixed ranges in °C by pressure level ----
TEMP_RANGES_C = {
    850: (-40.0, 35.0),
    500: (-70.0, 0.0),
    250: (-80.0, -25.0),
}


def encode_temp_r_png(temp_c: np.ndarray, pressure_level: int) -> bytes:
    """Encode Temperature(°C)->R, G/B=0, A=255 with fixed ranges."""
    if pressure_level not in TEMP_RANGES_C:
        raise ValueError(f"Unsupported pressure level for fixed ranges: {pressure_level}")

    tmin, tmax = TEMP_RANGES_C[pressure_level]

    r = scale_fixed_range(temp_c, tmin, tmax)
    zeros = np.zeros_like(r, dtype=np.uint8)
    a = np.full_like(r, 255, dtype=np.uint8)

    rgba = np.dstack([r, zeros, zeros, a])
    image = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def main():
    # --- inline config (no CLI) ---
    pressureLevel = 500
    grib_path = "."  # set to your GRIB path
    out_dir = f"../data/temp_images/{pressureLevel}"
    os.makedirs(out_dir, exist_ok=True)

    ds = open_dataset(grib_path)

    # Temperature at the pressure level (ERA5 temperature variable is 't' in Kelvin)
    t_da = select_level_component(ds, "t", pressureLevel)

    # Determine time coordinate
    if "time" in t_da.dims or "time" in t_da.coords:
        time_coord = "time"
    elif "valid_time" in t_da.coords:
        time_coord = "valid_time"
    else:
        raise KeyError("No time coordinate found (expected 'time' or 'valid_time')")

    # Coordinates
    lat = t_da.latitude.values
    lon = t_da.longitude.values

    # Times
    times = t_da[time_coord].values
    if times.size == 0:
        print("No time steps found in dataset")
        return

    # Fixed date window
    start_np = np.datetime64("2017-08-01T00")
    end_np   = np.datetime64("2017-09-30T23")
    mask = (times >= start_np) & (times <= end_np)
    selected_times = times[mask]
    if selected_times.size == 0:
        t0 = np.datetime_as_string(times[0], unit="h")
        tN = np.datetime_as_string(times[-1], unit="h")
        print(
            f"No times within happy-path window (2017-08-01T00 .. 2017-09-30T23). "
            f"Dataset range is {t0} .. {tN}"
        )
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
        png_path = os.path.join(out_dir, f"temp_{ts}.png")

        # Extract slice
        t_sl = t_da.sel({time_coord: np.datetime64(t)})

        t_vals_k = t_sl.values.astype(np.float32)
        if t_vals_k.ndim != 2:
            raise RuntimeError("Unexpected data shape; expected 2D lat-lon for temperature")

        # Convert K -> °C
        t_vals_c = t_vals_k - 273.15

        # Normalize longitude and latitude orientation
        lon_t, t_fixed = to_minus180_180(lon, t_vals_c)

        # Keep a consistent lon axis if small numeric differences arise
        if lon_t.shape != lon_fixed.shape or not np.allclose(lon_t, lon_fixed):
            lon_fixed = lon_t

        if flip_lat:
            t_fixed = t_fixed[::-1, :]

        png_bytes = encode_temp_r_png(t_fixed, pressureLevel)

        with open(png_path, "wb") as f:
            f.write(png_bytes)

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] Wrote {os.path.basename(png_path)}")


if __name__ == "__main__":
    main()
