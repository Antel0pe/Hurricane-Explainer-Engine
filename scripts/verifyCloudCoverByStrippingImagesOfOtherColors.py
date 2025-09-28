# Read the provided image, keep only the red channel, and save the result.
from PIL import Image
import numpy as np
from pathlib import Path

in_path = Path("/mnt/data/285fe42a-d7d3-4e75-8882-9984dec63589.png")
out_path = Path("/mnt/data/red_only.png")

img = Image.open(in_path).convert("RGBA")  # keep alpha if present
arr = np.array(img)

# Zero out Green and Blue channels; preserve Red and Alpha
if arr.shape[2] == 4:
    r, g, b, a = arr[:,:,0], arr[:,:,1], arr[:,:,2], arr[:,:,3]
    new_arr = np.stack([r, np.zeros_like(g), np.zeros_like(b), a], axis=2)
else:
    r, g, b = arr[:,:,0], arr[:,:,1], arr[:,:,2]
    new_arr = np.stack([r, np.zeros_like(g), np.zeros_like(b)], axis=2)

out_img = Image.fromarray(new_arr.astype(np.uint8), mode=img.mode)
out_img.save(out_path)

out_path, out_img.size
