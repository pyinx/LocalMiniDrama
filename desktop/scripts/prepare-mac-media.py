"""Prepare universal FFmpeg tools from pinned macOS distributions."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from urllib.request import urlopen
import zipfile


destination = Path(__file__).resolve().parents[1] / "ffmpeg-mac"
sources = json.loads((destination / "licenses/MEDIA-TOOLS-SOURCES.json").read_text())


def extract_binary(component, archive, binary):
    with urlopen(component["url"], timeout=180) as response:
        archive.write_bytes(response.read())
    checksum = component.get("archive_sha256")
    if checksum and hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise ValueError("Checksum mismatch for " + component["distribution"])
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as package:
            contents = package.read(component["archive_member"])
    else:
        with tarfile.open(archive) as package:
            contents = package.extractfile(component["archive_member"]).read()
    if hashlib.sha256(contents).hexdigest() != component["binary_sha256"]:
        raise ValueError("Binary checksum mismatch for " + component["distribution"])
    binary.write_bytes(contents)


def prepare(name):
    target = destination / name
    if target.is_file():
        subprocess.run(["lipo", target, "-verify_arch", "arm64", "x86_64"], check=True)
        if not os.access(target, os.X_OK):
            raise PermissionError(str(target) + " requires execute permission")
        return
    with tempfile.TemporaryDirectory(dir=destination) as working:
        scratch = Path(working)
        slices = []
        for source in sources["components"]:
            binary = scratch / source["platform"]
            extract_binary(source[name], scratch / "archive", binary)
            slices.append(binary)
        result = scratch / name
        subprocess.run(["lipo", "-create", *slices, "-output", result], check=True)
        result.chmod(0o755)
        subprocess.run(["codesign", "--force", "--sign", "-", result], check=True)
        result.replace(target)


if __name__ == "__main__":
    for tool in ("ffmpeg", "ffprobe"):
        prepare(tool)
