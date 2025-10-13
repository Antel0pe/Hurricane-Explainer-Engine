#!/usr/bin/env python3
# pip install rasterio
import numpy as np
import rasterio as rio
from rasterio.enums import Resampling
from PIL import Image

GEBCO_NC = "./GEBCO_2025.nc"       # GEBCO NetCDF (CF with lat/lon)
VAR_NAME = "elevation"             # adjust if different (e.g., "z" or similar)
OUT_PNG  = "./gebco_4k_uint16.png"
VMIN, VMAX = 0.0, 10000.0
W, H = 4096, 2048

def main():
    # Open the NetCDF variable as a raster band using subdataset URL
    # Many GEBCO files expose each variable as a “NETCDF:...:var” path
    # If VAR_NAME unsure, run: rio.open(GEBCO_NC).subdatasets
    src_path = f"NETCDF:{GEBCO_NC}:{VAR_NAME}"
    with rio.open(src_path) as src:
        # Read directly at target size with average resampling (streamed)
        arr = src.read(
            1,
            out_shape=(H, W),
            resampling=Resampling.average,
            masked=False
        ).astype(np.float32)

    # NaN→0, clamp negatives→0, then clamp to [VMIN, VMAX]
    np.nan_to_num(arr, copy=False, nan=0.0)
    np.maximum(arr, 0.0, out=arr)
    np.clip(arr, VMIN, VMAX, out=arr)

    # Scale to uint16
    scaled = np.rint((arr - VMIN) / (VMAX - VMIN) * 65535.0).astype(np.uint16)

    # Save 16-bit grayscale PNG
    Image.fromarray(scaled, mode="I;16").save(OUT_PNG, optimize=True, compress_level=6)

    km_per_px = 40075.017/ W  # rough at equator for equirect
    dz = (VMAX - VMIN) / 65535.0
    print(f"Wrote {OUT_PNG} [{W}×{H}], ≈{km_per_px:.2f} km/px, {dz:.2f} m vertical step")

if __name__ == "__main__":
    main()
