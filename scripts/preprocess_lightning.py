import io, os, gc
import numpy as np
import xarray as xr
from PIL import Image

# ---------- Openers (lazy, time-chunked) ----------

def open_cfgrib_var(path: str, shortName: str, index_tag: str):
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    # Chunk time by 1 so we can pull one slice at a time without materializing the whole cube
    ds = xr.open_dataset(
        path,
        engine="cfgrib",
        chunks={"time": 1},  # key to keep everything lazy
        backend_kwargs={
            "filter_by_keys": {"shortName": shortName},
            "indexpath": f"{path}.{index_tag}.idx",
        },
    )
    da = ds[shortName].squeeze(drop=True)

    # Ensure ascending latitude without copying full array: just rely on indexing later
    asc_lat = False
    if "latitude" in da.coords and da.latitude.ndim == 1:
        latv = da.latitude.values
        asc_lat = np.any(np.diff(latv) > 0)  # true if ascending
    da = da.assign_coords(valid_time=da["time"]).swap_dims({"time": "valid_time"})
    return da, asc_lat

def select_cape_crr(path: str):
    cape, cape_lat_asc = open_cfgrib_var(path, shortName="cape", index_tag="cape")
    crr,  crr_lat_asc  = open_cfgrib_var(path, shortName="crr",  index_tag="crr")

    # We won’t call .reindex_like() on the whole arrays (that can force big copies).
    # Instead, we’ll apply the same per-slice transforms to each variable.

    time_coord = "valid_time"
    lat = cape.latitude.values
    lon = cape.longitude.values

    # Precompute latitude flip once (views will be used each time)
    flip_lat = False
    if lat.ndim == 1:
        flip_lat = lat[0] < lat[-1]  # descending is typical; flip if ascending
    if flip_lat:
        lat = lat[::-1]

    # Precompute the roll/order for [0,360] -> [-180,180] ONCE
    lon0 = lon.copy()
    nx = lon0.size
    dlon = float(np.round((lon0[1] - lon0[0]) * 1e6) / 1e6)
    if lon0.min() >= -180 and lon0.max() <= 180:
        shift = 0
        order = np.arange(nx)
        lon_fixed = lon0
    else:
        shift = int(np.round((-180.0 - lon0[0]) / dlon)) % nx
        lon_shifted = lon0 + shift * dlon
        lon_shifted = ((lon_shifted + 180.0) % 360.0) - 180.0
        order = np.argsort(lon_shifted)
        lon_fixed = lon_shifted[order]

    return cape, crr, time_coord, lat, lon_fixed, flip_lat, shift, order

# ---------- CP -> Probability (in-place friendly) ----------

def cp_to_probability_inplace(cp2d: np.ndarray,
                            log_lo: float = 3.0,  p_lo: float = 0.05,
                            log_hi: float = 5.5,  p_hi: float = 0.97):
    # Solve A, B for logit(p) = A + B*x, x = log10(CP)
    def logit(p): return np.log(p / (1.0 - p))
    x1, x2 = log_lo, log_hi
    B = (logit(p_hi) - logit(p_lo)) / (x2 - x1)
    A = logit(p_lo) - B * x1

    # Reuse cp2d as the working buffer to avoid extra arrays
    # CP <= 0 → set to tiny before log10
    np.maximum(cp2d, 1e-9, out=cp2d)
    np.log10(cp2d, out=cp2d)                      # cp2d now holds x
    np.multiply(cp2d, B, out=cp2d)                # B*x
    np.add(cp2d, A, out=cp2d)                     # A + B*x
    np.negative(cp2d, out=cp2d)                   # -(A + B*x)
    np.exp(cp2d, out=cp2d)                        # exp(-(...))
    np.add(cp2d, 1.0, out=cp2d)                   # 1 + exp(-(...))
    np.reciprocal(cp2d, out=cp2d)                 # 1 / (1 + exp(...))
    np.clip(cp2d, 0.0, 1.0, out=cp2d)             # cp2d now holds prob in [0,1]
    return cp2d

def encode_prob_png_inplace(prob2d: np.ndarray) -> bytes:
    # Convert to uint8 without making an extra float copy
    gray = np.rint(prob2d * 255.0, out=prob2d).astype(np.uint8, copy=False)
    im = Image.fromarray(gray, mode="L")
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf.read()

def _times_as(arr, unit="h"):
    # Normalize a datetime64 array to a specific unit (hour is good for ERA5 hourly)
    return arr.astype(f"datetime64[{unit}]")

def compute_common_times(cape, crr, time_coord="valid_time", unit="h"):
    t_cape = _times_as(cape[time_coord].values, unit=unit)
    t_crr  = _times_as(crr [time_coord].values, unit=unit)
    common = np.intersect1d(t_cape, t_crr)
    if common.size == 0:
        raise RuntimeError(
            f"No overlapping times after normalization to '{unit}'. "
            f"CAPE range: {t_cape.min()}..{t_cape.max()}, "
            f"CRR range: {t_crr.min()}..{t_crr.max()}"
        )
    return common

def select_2d_at_time(da, t, time_coord="valid_time",
                      method=None, tolerance=None):
    """
    Return a 2D [latitude, longitude] slice at time t.
    If method == 'nearest', we pick the closest timestamp by NumPy (robust to
    duplicates / non-monotonic indices) and enforce `tolerance` if given.
    """
    # --- choose time ---
    if method == "nearest":
        # normalize both to hours to match your driver times
        t_da = da[time_coord].values
        t_da_h = t_da.astype("datetime64[h]")
        t_h = np.asarray(t).astype("datetime64[h]")

        # argmin over absolute difference
        diffs = np.abs(t_da_h - t_h)
        i = int(np.argmin(diffs))
        if tolerance is not None and diffs[i] > tolerance:
            raise KeyError(f"no time within tolerance {tolerance} of {t_h}")

        da = da.isel({time_coord: i})
    else:
        # exact match (or xarray-managed selection)
        if time_coord in da.coords:
            da = da.sel({time_coord: t}, method=method, tolerance=tolerance)
        elif "time" in da.coords:
            da = da.sel(time=t, method=method, tolerance=tolerance)
        else:
            raise KeyError("No time coordinate")

    # --- drop nuisance dims and ensure 2D [lat, lon] ---
    for dim in list(da.dims):
        if dim in ("latitude", "longitude"):
            continue
        da = da.isel({dim: 0}) if da.sizes.get(dim, 1) > 1 else da.squeeze(dim, drop=True)

    da = da.squeeze(drop=True)
    if set(da.dims) != {"latitude", "longitude"}:
        raise RuntimeError(f"Expected 2D [latitude, longitude]; got {da.dims} with sizes {da.sizes}")

    return da

# ---------- Main (streaming, per-time-slice) ----------

def main():
    grib_path = "/mnt/c/Users/dmmsp/Downloads/lightning.grib"
    out_dir   = "/mnt/c/Users/dmmsp/Projects/Hurricane-Explainer-Engine/data/lightning"
    os.makedirs(out_dir, exist_ok=True)

    cape, crr, time_coord, lat, lon_fixed, flip_lat, shift, order = select_cape_crr(grib_path)
    # Drive the loop by CAPE's hourly timestamps
    t_cape_h = _times_as(cape[time_coord].values, unit="h")
    t_crr_h  = _times_as(crr [time_coord].values, unit="h")

    # We'll accept CRR nearest within ±3 hours
    tol = np.timedelta64(6, "h")

    # Keep only CAPE hours that are within CRR coverage ± tol (avoids KeyError at edges)
    tmin = t_crr_h.min() - tol
    tmax = t_crr_h.max() + tol
    times = t_cape_h[(t_cape_h >= tmin) & (t_cape_h <= tmax)]

    print(f"Dataset time range: {np.datetime_as_string(times[0], unit='h')} .. {np.datetime_as_string(times[-1], unit='h')}")
    # Constants
    MPS_TO_MMPH = 3_600_000.0  # 1 m/s -> mm/h

    total = len(times)
    for idx, t in enumerate(times, start=1):
        ts = np.datetime_as_string(t, unit="h").replace("-", "").replace(":", "").replace("T", "")
        png_path = os.path.join(out_dir, f"lightning_{ts}.png")

        # CAPE exact hour; CRR nearest within ±3h
        C2d_da   = select_2d_at_time(cape, t, time_coord=time_coord, method=None,      tolerance=np.timedelta64(0, "m"))
        CRR2d_da = select_2d_at_time(crr,  t, time_coord=time_coord, method="nearest", tolerance=tol)  # tol = 3h


        C2d   = np.asarray(C2d_da.data, dtype=np.float32)
        CRR2d = np.asarray(CRR2d_da.data, dtype=np.float32)

        # Apply latitude flip as a view (no copy)
        if flip_lat:
            C2d = C2d[::-1, :]
            CRR2d = CRR2d[::-1, :]

        # Apply 0..360 → -180..180 using one roll + reorder (these create new arrays once per slice)
        if shift:
            C2d = np.roll(C2d, shift=shift, axis=1)[:, order]
            CRR2d = np.roll(CRR2d, shift=shift, axis=1)[:, order]
        elif order is not None and (order[0] != 0 or not np.all(order == np.arange(order.size))):
            C2d = C2d[:, order]
            CRR2d = CRR2d[:, order]

        # Convert CRR to mm/h in-place
        CRR2d *= MPS_TO_MMPH

        # CP = CAPE * CRR (reuse C2d’s buffer for CP to avoid allocating another big array)
        # C2d becomes CP here
        np.multiply(C2d, CRR2d, out=C2d)
        # Free CRR2d ASAP
        del CRR2d

        # Replace NaNs with 0 in-place
        np.nan_to_num(C2d, copy=False, nan=0.0, posinf=0.0, neginf=0.0)

        # Map CP -> probability in-place (C2d reused as prob)
        prob = cp_to_probability_inplace(C2d)

        # Encode and write
        png_bytes = encode_prob_png_inplace(prob)
        with open(png_path, "wb") as f:
            f.write(png_bytes)

        # Explicit cleanup to keep peak RSS low
        del C2d, prob, png_bytes
        if idx % 8 == 0:  # occasional GC batches
            gc.collect()

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] Wrote {os.path.basename(png_path)}")

if __name__ == "__main__":
    main()
