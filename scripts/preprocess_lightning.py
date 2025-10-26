import io
import os
from datetime import datetime

import numpy as np
import xarray as xr
from PIL import Image


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


def select_cape_crr(ds: xr.Dataset):
    """
    Return (cape, crr, time_coord) aligned on time/lat/lon.

    - cape: Convective available potential energy [J kg^-1]
    - crr : Convective rain rate [m s^-1]
    """
    cape = get_var(ds, ["cape", "convective_available_potential_energy"])
    crr  = get_var(ds, ["crr", "convective_rain_rate"])

    def fix_lat(da: xr.DataArray) -> xr.DataArray:
        if "latitude" in da.coords and da.latitude.ndim == 1 and np.any(np.diff(da.latitude.values) < 0):
            return da.sortby("latitude")
        return da

    cape = fix_lat(cape)
    crr  = fix_lat(crr)

    time_coord = "time" if "time" in cape.coords else ("valid_time" if "valid_time" in cape.coords else None)
    if time_coord is None:
        raise KeyError("No time coordinate found (expected 'time' or 'valid_time').")

    # align CRR to CAPE grid
    crr = crr.reindex_like(cape, method=None, copy=False)

    return cape, crr, time_coord


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


# ---------- CP -> Probability mapping (logistic on log10(CP)) ----------

def cp_to_probability(cp2d: np.ndarray,
                      log_lo: float = 3.0,  p_lo: float = 0.05,   # ~5% at CP=1e3
                      log_hi: float = 5.5,  p_hi: float = 0.97):  # ~97% at CP≈3e5
    """
    Map CP (CAPE[J/kg] * convective rain rate[mm/h]) to probability (0..1).
    Uses a logistic fit constrained to pass through (log_lo -> p_lo) and (log_hi -> p_hi).
    """
    # Solve for A,B in: logit(p) = A + B * x, where x = log10(CP)
    def logit(p): return np.log(p / (1.0 - p))
    x1, x2 = log_lo, log_hi
    B = (logit(p_hi) - logit(p_lo)) / (x2 - x1)
    A = logit(p_lo) - B * x1

    x = np.log10(np.clip(cp2d, 1e-9, None))
    prob = 1.0 / (1.0 + np.exp(-(A + B * x)))
    # Clean up
    prob = np.where(np.isfinite(prob), prob, 0.0)
    return np.clip(prob, 0.0, 1.0)


def encode_prob_png(prob2d: np.ndarray) -> bytes:
    """Encode 0..1 probability to 8-bit grayscale PNG (0..255)."""
    gray = np.rint(np.clip(prob2d, 0.0, 1.0) * 255.0).astype(np.uint8)
    im = Image.fromarray(gray, mode="L")
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf.read()


def main():
    # --- paths (adjust) ---
    grib_path = "/mnt/c/Users/dmmsp/Downloads/cape_crr.grib"
    out_dir   = "/mnt/c/Users/dmmsp/Projects/Hurricane-Explainer-Engine/data/lightning_prob"
    os.makedirs(out_dir, exist_ok=True)

    ds = open_era5_dataset(grib_path)
    cape, crr, time_coord = select_cape_crr(ds)

    lat = cape.latitude.values
    lon = cape.longitude.values
    times = cape[time_coord].values

    print(f"Dataset time range: {np.datetime_as_string(times[0], unit='h')} .. {np.datetime_as_string(times[-1], unit='h')}")

    # ensure we work with north->south decreasing if needed (consistent orientation)
    lat_work = lat.copy()
    flip_lat = lat_work[0] < lat_work[-1]
    if flip_lat:
        lat_work = lat_work[::-1]

    total = len(times)
    for idx, t in enumerate(times, start=1):
        ts = np.datetime_as_string(t, unit="h").replace("-", "").replace(":", "").replace("T", "")
        png_path = os.path.join(out_dir, f"lightning_prob_{ts}.png")

        # Extract 2D slices
        C2d   = cape.sel({time_coord: np.datetime64(t)}).values.astype(np.float32)  # J/kg
        CRR2d = crr.sel({time_coord: np.datetime64(t)}).values.astype(np.float32)   # m/s

        if flip_lat:
            C2d   = C2d[::-1, :]
            CRR2d = CRR2d[::-1, :]

        # Shift longitudes to [-180,180]
        lon_fixed, C2d   = to_minus180_180(lon, C2d)
        _,         CRR2d = to_minus180_180(lon, CRR2d)

        # --- Units: convective rain rate m/s -> mm/h
        crr_mmph = CRR2d * (1000.0 * 3600.0)  # 1 m/s = 1000 mm/s; *3600 = mm/h

        # --- CP predictor (J/kg * mm/h)
        CP = np.nan_to_num(C2d, nan=0.0) * np.nan_to_num(crr_mmph, nan=0.0)

        # --- Probability from CP (defaults: ~5% at 1e3, ~97% at 3e5)
        prob = cp_to_probability(CP, log_lo=3.0, p_lo=0.05, log_hi=5.5, p_hi=0.97)

        # --- Encode to single-channel PNG (0..255 = 0–100%)
        png_bytes = encode_prob_png(prob)
        with open(png_path, "wb") as f:
            f.write(png_bytes)

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] Wrote {os.path.basename(png_path)}")


if __name__ == "__main__":
    main()
