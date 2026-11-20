#!/usr/bin/env python3
"""Build the Zotero installation package from the checked-in add-on files."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
ADDON = ROOT / "addon"
DIST = ROOT / "dist"


def build():
    manifest = json.loads((ADDON / "manifest.json").read_text(encoding="utf-8"))
    destination = DIST / f"{manifest['name']}-{manifest['version']}.xpi"
    files = sorted(path for path in ADDON.rglob("*") if path.is_file()
                   and not any(part.startswith(".") for part in path.relative_to(ADDON).parts))
    if (ADDON / "bootstrap.js") not in files:
        raise FileNotFoundError("addon/bootstrap.js")

    DIST.mkdir(exist_ok=True)
    with TemporaryDirectory(dir=DIST) as directory:
        package = Path(directory) / destination.name
        with ZipFile(package, "w", compression=ZIP_DEFLATED) as bundle:
            for path in files:
                entry = ZipInfo(path.relative_to(ADDON).as_posix())
                entry.compress_type = ZIP_DEFLATED
                entry.external_attr = 0o644 << 16
                bundle.writestr(entry, path.read_bytes())
        with ZipFile(package) as bundle:
            bad_file = bundle.testzip()
            if bad_file:
                raise RuntimeError(f"Corrupt XPI entry {bad_file}")
        package.replace(destination)
    return destination


if __name__ == "__main__":
    print(build())
