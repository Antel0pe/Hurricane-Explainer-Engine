"""
plot_uv_from_png.py

Load a PNG where U is encoded in the Red channel and V in the Green channel
(0..255 range), convert to approximate wind direction vectors, and render
a global quiver plot. Assumes an equirectangular grid at ~0.25° resolution
(1440x721 typical), with top row = 90°N and lon in [-180, 180).

Usage (as a module):
    from plot_uv_from_png import quiver_from_uv_png
    quiver_from_uv_png("uv_YYYYMMDDHH.png", out_png="quiver.png", stride=8)

Notes
-----
- Because the source PNG used per-slice min/max scaling, magnitudes are *not*
  physically meaningful. We normalize vectors to unit length and only use
  direction (the arrow points where the wind is blowing toward).
- If you later switch to a fixed physical scaling for U/V, you can replace
  the decode_rg_to_uv() function to invert that mapping and get true speeds.
"""

from pathlib import Path
from typing import Optional
import numpy as np
from PIL import Image
import matplotlib.pyplot as plt


def decode_rg_to_uv(r: np.ndarray, g: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Map 0..255 channel values to a symmetric range [-1, 1] so that
    direction can be inferred. This is an approximation because the
    source was min-max scaled per slice.
    """
    # Map to [-1, 1]; 127.5 ≈ 0 reference.
    u = (r.astype(np.float32) - 127.5) / 127.5
    v = (g.astype(np.float32) - 127.5) / 127.5
    return u, v


def quiver_from_uv_png(
    png_path: str | Path,
    out_png: Optional[str | Path] = None,
    stride: int = 8,
    figsize: tuple[float, float] = (14, 7),
    arrow_scale: float = 55.0,
    linewidth: float = 0.2,
):
    """
    Render a quiver plot of wind *direction* from an RG-encoded UV PNG.

    Parameters
    ----------
    png_path : str | Path
        Path to the input PNG (RGBA). R=U, G=V, B ignored, A optional.
    out_png : str | Path, optional
        If provided, save the figure here.
    stride : int, default 8
        Subsampling factor for arrows (1 => every 0.25°, 4 => ~1°, etc.).
        Be cautious with stride=1 (≈ 1M arrows); it can be very slow.
    figsize : (w, h), default (14, 7)
        Figure size in inches.
    arrow_scale : float, default 55.0
        Matplotlib quiver scale parameter (tune for visual density).
    linewidth : float, default 0.2
        Line width for arrows.
    """
    png_path = Path(png_path)
    img = Image.open(png_path).convert("RGBA")
    arr = np.array(img)  # H x W x 4
    H, W, _ = arr.shape

    # Extract channels
    r = arr[..., 0]
    g = arr[..., 1]

    # Decode approximate U, V and normalize to unit vectors (direction only)
    u, v = decode_rg_to_uv(r, g)
    mag = np.hypot(u, v)
    # Mask tiny magnitudes (avoid NaNs/flat regions); keep direction only
    eps = 1e-6
    u_dir = np.where(mag > eps, u / (mag + 1e-12), 0.0)
    v_dir = np.where(mag > eps, v / (mag + 1e-12), 0.0)

    # Build lon/lat grids for an equirectangular map at 0.25° resolution.
    # Width W ≈ 1440 => 360 / 0.25; Height H ≈ 721 => 180 / 0.25 + 1.
    # We'll use pixel-center coordinates.
    dlon = 360.0 / W
    dlat = 180.0 / (H - 1) if H > 1 else 180.0  # includes both poles
    lon = (-180.0 + dlon/2.0) + dlon * np.arange(W)
    lat = (90.0 - dlat * np.arange(H))  # top row ≈ 90N

    # Subsample
    sl_y = slice(0, H, stride)
    sl_x = slice(0, W, stride)
    Lon, Lat = np.meshgrid(lon[sl_x], lat[sl_y])
    U = u_dir[sl_y, sl_x]
    V = v_dir[sl_y, sl_x]

    # Matplotlib uses X→east (lon), Y→north (lat). Our V should be +north.
    # The PNG was written with north at the top, so no flip is needed here.

    fig, ax = plt.subplots(figsize=figsize, dpi=150)
    # Set geographic extent; origin='upper' matches the PNG orientation.
    ax.set_xlim(-180, 180)
    ax.set_ylim(-90, 90)
    ax.set_xlabel("Longitude (°)")
    ax.set_ylabel("Latitude (°)")
    ax.set_title("Wind Direction (from RG-encoded UV PNG)")

    # Draw coast-like frame (no basemap dependence).
    ax.grid(True, linewidth=0.2, alpha=0.4)

    # Quiver plot (direction only)
    q = ax.quiver(
        Lon, Lat, U, V,
        scale=arrow_scale,
        width=0.0012,
        headwidth=3.5,
        headlength=5.0,
        headaxislength=4.0,
        linewidth=linewidth,
        pivot="middle",
        minlength=0.0,
        angles="xy",
        scale_units="xy",
    )

    # Optional key for reference
    ax.quiverkey(q, 0.9, -0.02, 1.0, "unit vector", labelpos="E")

    fig.tight_layout()
    if out_png is not None:
        out_png = Path(out_png)
        fig.savefig(out_png, bbox_inches="tight")
    return fig, ax


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Render quiver from RG-encoded UV PNG")
    p.add_argument("png_path", help="Path to input RG-encoded UV PNG")
    p.add_argument("--out", dest="out_png", default=None, help="Optional output PNG path")
    p.add_argument("--stride", type=int, default=8, help="Arrow spacing in pixels (1=every 0.25°)")
    p.add_argument("--figwidth", type=float, default=14.0)
    p.add_argument("--figheight", type=float, default=7.0)
    p.add_argument("--scale", type=float, default=55.0, help="Matplotlib quiver scale")
    args = p.parse_args()
    quiver_from_uv_png(args.png_path, out_png=args.out_png, stride=args.stride,
                       figsize=(args.figwidth, args.figheight), arrow_scale=args.scale)