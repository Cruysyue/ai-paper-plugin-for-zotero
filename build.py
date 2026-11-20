#!/usr/bin/env python3
"""Build the Zotero installation package from the checked-in add-on files."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
ADDON = ROOT / "addon"
DIST = ROOT / "dist"


def read_manifest():
    return json.loads((ADDON / "manifest.json").read_text(encoding="utf-8"))


def build(manifest=None):
    if manifest is None:
        manifest = read_manifest()
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


def build_release(tag, repository):
    manifest = read_manifest()
    version = manifest["version"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or tag != f"v{version}":
        raise ValueError(f"Release tag {tag} must have the form vX.Y.Z and match manifest version {version}.")

    zotero = manifest["applications"]["zotero"]
    releases_url = f"https://github.com/{repository}/releases"
    update_url = f"{releases_url}/latest/download/updates.json"
    if zotero["update_url"] != update_url:
        raise ValueError(f"The manifest update_url must point to {update_url}.")

    package = build(manifest)
    sha256 = hashlib.sha256(package.read_bytes()).hexdigest()
    update = {
        "version": version,
        "update_link": f"{releases_url}/download/{tag}/{package.name}",
        "update_hash": f"sha256:{sha256}",
        "applications": {
            "zotero": {
                "strict_min_version": zotero["strict_min_version"],
                "strict_max_version": zotero["strict_max_version"],
            },
        },
    }
    updates = {"addons": {zotero["id"]: {"updates": [update]}}}
    with TemporaryDirectory(dir=DIST) as directory:
        feed = Path(directory) / "updates.json"
        feed.write_text(json.dumps(updates, indent=2) + "\n", encoding="utf-8")
        feed.replace(DIST / feed.name)
    return package


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", nargs=2, metavar=("TAG", "OWNER/REPO"),
                        help="also generate the Zotero update manifest for a GitHub release")
    args = parser.parse_args()
    if args.release:
        try:
            print(build_release(*args.release))
        except ValueError as error:
            parser.error(str(error))
    else:
        print(build())
