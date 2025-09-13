import os
from datetime import datetime

from flask import Flask, Response, abort
from flask_cors import CORS

# ---- Fixed ERA5 grid (0.25° global) ----
NX = 1440                    # longitudes (0.25° from 0..359.75)
NY = 721                     # latitudes (0.25° from 90..-90)
BOUNDS = (-180.0, -90.0, 179.75, 90.0)  # [minLon, minLat, maxLon, maxLat]

def resolve_gph_image_dir(pressure_level: str) -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    out_dir = os.path.join(root, "data", "gphImages", str(pressure_level))
    os.makedirs(out_dir, exist_ok=True)
    return out_dir

def resolve_uv_image_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    out_dir = os.path.join(root, "data", "uv_images", "250")
    os.makedirs(out_dir, exist_ok=True)
    return out_dir

def resolve_landmask_image_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, os.pardir))
    out_path = os.path.join(root, "data", "landMask.png")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    return out_path

def parse_datehour(value: str):
    v = value.strip()
    from datetime import datetime
    if v.isdigit():
        if len(v) == 10:
            return datetime.strptime(v, "%Y%m%d%H")
        elif len(v) == 12:
            return datetime.strptime(v, "%Y%m%d%H%M")
    iso = v.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H", "%Y-%m-%d %H", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(iso, fmt)
        except ValueError:
            pass
    raise ValueError(f"Unsupported datehour format: {value}")

def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app, resources={r"/*": {"origins": "*"}}, expose_headers=["X-Bounds", "X-Size"])

    def add_headers(resp: Response) -> Response:
        resp.headers["X-Bounds"] = ",".join(map(str, BOUNDS))
        resp.headers["X-Size"] = f"{NX}x{NY}"
        return resp

    @app.get("/gph/<pressureLevel>/<datehour>")
    def gph(pressureLevel: str, datehour: str):
        try:
            dt = parse_datehour(datehour)
        except ValueError:
            abort(400, description="Invalid datehour format")

        ts = dt.strftime("%Y%m%d%H")
        image_path = os.path.join(resolve_gph_image_dir(pressureLevel), f"gph_{ts}.png")
        if not os.path.exists(image_path):
            abort(404, description="image doesn't exist")

        with open(image_path, "rb") as f:
            data = f.read()
        return add_headers(Response(data, mimetype="image/png"))

    @app.get("/uv/<datehour>")
    def uv(datehour: str):
        try:
            dt = parse_datehour(datehour)
        except ValueError:
            abort(400, description="Invalid datehour format")

        ts = dt.strftime("%Y%m%d%H")
        image_path = os.path.join(resolve_uv_image_dir(), f"uv_{ts}.png")
        if not os.path.exists(image_path):
            abort(404, description="image doesn't exist")

        with open(image_path, "rb") as f:
            data = f.read()
        return add_headers(Response(data, mimetype="image/png"))

    @app.get("/landMask")
    def land_mask():
        image_path = resolve_landmask_image_path()
        if not os.path.exists(image_path):
            abort(404, description="image doesn't exist")

        with open(image_path, "rb") as f:
            data = f.read()
        return add_headers(Response(data, mimetype="image/png"))

    return app

app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8001)))
