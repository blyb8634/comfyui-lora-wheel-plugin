"""Build the local ComfyUI custom-node ZIP without models or test fixtures."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
FILES = (
    "README.md",
    "LICENSE",
    "__init__.py",
    "civitai.py",
    "web/extension.js",
    "web/wheel.css",
    "web/wheel.js",
)
DESTINATION = ROOT / "dist" / "comfyui-lora-wheel.zip"


def main():
    missing = [name for name in FILES if not (ROOT / name).is_file()]
    if missing:
        raise SystemExit(f"Missing package files: {', '.join(missing)}")
    DESTINATION.parent.mkdir(exist_ok=True)
    with ZipFile(DESTINATION, "w", compression=ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(ROOT / name, f"comfyui-lora-wheel/{name}")
    with ZipFile(DESTINATION) as archive:
        expected = [f"comfyui-lora-wheel/{name}" for name in FILES]
        if archive.namelist() != expected or archive.testzip() is not None:
            raise SystemExit("Package verification failed")
    print(f"Built {DESTINATION} ({DESTINATION.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
