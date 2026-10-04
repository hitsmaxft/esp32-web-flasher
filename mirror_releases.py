#!/usr/bin/env python3
"""Build a self-contained Pages artifact with verified public XiaoZhi ZIPs."""

import argparse
import concurrent.futures
import hashlib
import json
import re
import shutil
import time
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_FILES = ("index.html", "style.css", "app.js", "firmware.js", "catalog.json")
MAX_TOTAL = 850 * 1024 * 1024


def app_partitions(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if names != ["merged-binary.bin"]:
            raise ValueError(f"Unexpected release ZIP contents: {archive_path.name}")
        image = archive.read("merged-binary.bin")
    if len(image) < 0x9000:
        raise ValueError(f"Merged image too small: {archive_path.name}")
    result = []
    for offset in range(0x8000, 0x8c00, 32):
        entry = image[offset:offset + 32]
        if entry[:2] != b"\xaa\x50":
            break
        if entry[2] != 0:
            continue
        address = int.from_bytes(entry[4:8], "little")
        size = int.from_bytes(entry[8:12], "little")
        label = entry[12:28].split(b"\0", 1)[0].decode("ascii")
        if not label or address < 0x10000 or address % 0x1000 or size <= 0 or address + size > 32 * 1024 * 1024:
            raise ValueError(f"Invalid application partition: {archive_path.name}")
        result.append({"label": label, "offset": address, "size": size})
    if not result:
        raise ValueError(f"No application partitions: {archive_path.name}")
    return result


def download(profile, destination):
    name = profile["mirror"]
    expected_size = profile["bytes"]
    expected_sha = profile["sha256"]
    url = profile["asset"]
    if not re.fullmatch(r"v\d+\.\d+\.\d+_[a-z0-9.-]+\.zip", name):
        raise ValueError(f"Unsafe asset name: {name}")
    if url != f"https://github.com/78/xiaozhi-esp32/releases/download/{name.split('_', 1)[0]}/{name}":
        raise ValueError(f"Unexpected release URL: {name}")
    if not isinstance(expected_size, int) or not 0 < expected_size <= 16 * 1024 * 1024:
        raise ValueError(f"Unexpected asset size: {name}")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha or ""):
        raise ValueError(f"Missing SHA-256: {name}")
    target = destination / name
    for attempt in range(3):
        digest = hashlib.sha256()
        size = 0
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "esp32-web-flasher-pages"})
            with urllib.request.urlopen(request, timeout=90) as response, target.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > expected_size:
                        raise ValueError(f"Asset larger than catalog: {name}")
                    digest.update(chunk)
                    output.write(chunk)
            if size != expected_size or digest.hexdigest() != expected_sha:
                raise ValueError(f"Size or SHA-256 mismatch: {name}")
            return profile["id"], name, app_partitions(target)
        except (OSError, ValueError):
            target.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only-id", help="Limit to one board for local verification")
    args = parser.parse_args()
    destination = args.out.resolve()
    if destination == HERE or HERE in destination.parents:
        raise SystemExit("Output must be outside web-flasher source directory")
    if destination.exists():
        raise SystemExit(f"Output already exists: {destination}")
    catalog = json.loads((HERE / "catalog.json").read_text())
    profiles = [p for p in catalog["profiles"] if p["asset"] and
                (not args.only_id or p["id"] == args.only_id)]
    if args.only_id and len(profiles) != 1:
        raise SystemExit(f"No unique public asset for {args.only_id}")
    total = sum(p["bytes"] for p in profiles)
    if total > MAX_TOTAL:
        raise SystemExit(f"Release assets total {total} bytes; exceeds Pages budget")
    destination.mkdir(parents=True)
    for name in PUBLIC_FILES:
        shutil.copy2(HERE / name, destination / name)
    shutil.copytree(HERE / "vendor", destination / "vendor")
    firmware_dir = destination / "firmware"
    firmware_dir.mkdir()
    offsets = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for profile_id, name, partitions in executor.map(lambda p: download(p, firmware_dir), profiles):
            offsets[profile_id] = partitions
            print(f"verified {name}", flush=True)
    (destination / "app-offsets.json").write_text(json.dumps({"release": catalog["release"],
        "profiles": offsets}, ensure_ascii=False, separators=(",", ":")))
    print(f"Prepared {len(profiles)} public ZIPs ({total / 1048576:.1f} MiB)")


if __name__ == "__main__":
    main()
