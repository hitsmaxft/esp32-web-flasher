#!/usr/bin/env python3
"""Snapshot XiaoZhi board configs and official release assets for the static site."""

import argparse
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "catalog.json"
API = "https://api.github.com/repos/78/xiaozhi-esp32/releases/latest"


def release_name(manufacturer, name):
    if name.endswith("-p4x") and "-p4-" in name[:-4]:
        name = name[:-4].replace("-p4-", "-p4x-", 1)
    prefix = f"{manufacturer}-" if manufacturer else ""
    return name if not prefix or name.startswith(prefix) else prefix + name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-json", type=Path, help="Cached GitHub release JSON for offline regeneration")
    parser.add_argument("--boards-dir", type=Path, required=True,
                        help="Path to the upstream xiaozhi-esp32/main/boards directory")
    args = parser.parse_args()
    if not args.boards_dir.is_dir():
        parser.error(f"Board configuration directory does not exist: {args.boards_dir}")
    if args.release_json:
        release = json.loads(args.release_json.read_text())
    else:
        request = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json", "User-Agent": "rlcd-web-flasher"})
        with urllib.request.urlopen(request, timeout=30) as response:
            release = json.load(response)
    assets = {asset["name"]: asset for asset in release["assets"]}
    tag = release["tag_name"]
    profiles = []
    for path in sorted(args.boards_dir.rglob("config.json")):
        config = json.loads(path.read_text())
        manufacturer = config.get("manufacturer")
        target = config["target"]
        board = path.parent.relative_to(args.boards_dir).as_posix()
        for build in config["builds"]:
            name = build["name"]
            full_name = release_name(manufacturer, name)
            asset_name = f"{tag}_{full_name}.zip"
            asset = assets.get(asset_name)
            digest = asset.get("digest") if asset else None
            if asset and (not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)):
                raise SystemExit(f"Missing SHA-256 digest for {asset_name}")
            profiles.append({
                "id": full_name,
                "board": board,
                "target": target,
                "name": name,
                "asset": asset["browser_download_url"] if asset else None,
                "sha256": digest[7:] if asset else None,
                "bytes": asset["size"] if asset else None,
                "mirror": asset_name if asset else None,
            })
    ids = [profile["id"] for profile in profiles]
    if len(ids) != len(set(ids)) or not all(re.fullmatch(r"[a-z0-9.-]+", name) for name in ids):
        raise SystemExit("Duplicate or unsafe release profile identifiers")
    profiles.sort(key=lambda p: (p["target"] not in ("esp32s3", "esp32s31"), p["board"], p["name"]))
    result = {"source": "78/xiaozhi-esp32", "release": tag, "profiles": profiles}
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(profiles)} profiles; {sum(bool(p['asset']) for p in profiles)} public release ZIPs; {tag}")


if __name__ == "__main__":
    main()
