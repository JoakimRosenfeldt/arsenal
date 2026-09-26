"""Build the offline Laya assets. Python is used only during this export."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "laya"
OUTPUT = ROOT / "assets" / "laya"
SOURCE_REVISION = "4066d5d5fbf08b66c6757ddeedbd797bd7655bc0"
MODEL_REVISION = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851"
MODEL_SHA256 = "891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c"
MODEL_URL = f"https://huggingface.co/convaiinnovations/laya/resolve/{MODEL_REVISION}"
SOURCE_URL = f"https://github.com/NandhaKishorM/laya/tree/{SOURCE_REVISION}"


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, path, sha256=None):
    if path.exists() and (sha256 is None or checksum(path) == sha256):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    print(f"Downloading {url}", flush=True)
    with urlopen(url, timeout=120) as response, partial.open("wb") as stream:
        shutil.copyfileobj(response, stream)
    if sha256 is not None and checksum(partial) != sha256:
        raise RuntimeError(f"Checksum failed: {path.name}")
    partial.replace(path)


def main():
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("The Laya exporter requires Python 3.12. Set LAYA_PYTHON to its executable.")
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / f"source-{SOURCE_REVISION}.tar.gz"
    source = CACHE / f"laya-{SOURCE_REVISION}"
    if not source.is_dir():
        download(f"https://codeload.github.com/NandhaKishorM/laya/tar.gz/{SOURCE_REVISION}", archive)
        with tarfile.open(archive) as bundle:
            bundle.extractall(CACHE, filter="data")
    checkpoint = CACHE / MODEL_REVISION
    for name in ["model.safetensors", "rl_agent_config.json", "encoder/config.json",
                 "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "README.md"]:
        download(f"{MODEL_URL}/{name}", checkpoint / name,
                 MODEL_SHA256 if name == "model.safetensors" else None)

    with tempfile.TemporaryDirectory(prefix="export-", dir=CACHE) as temporary:
        exported = Path(temporary) / "laya"
        subprocess.run([
            sys.executable, str(source / "laya-ts" / "scripts" / "export_onnx.py"),
            "--model-dir", str(checkpoint), "--out-dir", str(exported),
        ], check=True, env={
            **os.environ, "PYTHONPATH": str(source), "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1", "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4",
        })
        shutil.copyfile(source / "LICENSE", exported / "LICENSE.txt")
        shutil.copyfile(checkpoint / "README.md", exported / "MODEL_CARD.md")
        manifest = {
            "model": "convaiinnovations/laya",
            "modelRevision": MODEL_REVISION,
            "sourceRevision": SOURCE_REVISION,
            "source": SOURCE_URL,
            "checkpointSha256": MODEL_SHA256,
            "license": "Apache-2.0",
            "backbone": "answerdotai/ModernBERT-large",
            "format": "Split ONNX, opset 18, float32",
            "exportRequirementsSha256": hashlib.sha256(
                (ROOT / "scripts" / "prepare-laya.requirements.txt").read_text(encoding="utf-8").encode()
            ).hexdigest(),
            "files": {
                file.name: {"bytes": file.stat().st_size, "sha256": checksum(file)}
                for file in sorted(exported.iterdir()) if file.is_file()
            },
        }
        (exported / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        if OUTPUT.exists():
            shutil.rmtree(OUTPUT)
        shutil.move(str(exported), OUTPUT)
    print(f"Prepared Laya in {OUTPUT}", flush=True)


if __name__ == "__main__":
    main()
