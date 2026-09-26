"""Pin small ONNX templates and the verified checkpoint-to-weight mapping."""

import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
import onnx

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets" / "laya"
OUTPUT = ROOT / "vendor" / "laya-conversion"


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    manifest = json.loads((ASSETS / "manifest.json").read_text())
    checkpoint = ROOT / ".cache" / "laya" / manifest["modelRevision"] / "model.safetensors"
    if checksum(checkpoint) != manifest["checkpointSha256"]:
        raise ValueError("The checkpoint does not match the pinned model.")
    with checkpoint.open("rb") as stream:
        header_bytes = int.from_bytes(stream.read(8), "little")
        header = json.loads(stream.read(header_bytes))
    data_start = 8 + header_bytes
    raw = np.memmap(checkpoint, dtype=np.uint8, mode="r")
    index = {}
    for name, info in header.items():
        if name == "__metadata__":
            continue
        start, end = info["data_offsets"]
        dtype = {"F16": "<f2", "F32": "<f4"}[info["dtype"]]
        tensor = np.frombuffer(raw[data_start + start:data_start + end], dtype=dtype)
        tensor = tensor.reshape(info["shape"]).astype("<f4")
        for transpose in ([False, True] if tensor.ndim == 2 else [False]):
            data = (tensor.T if transpose else tensor).tobytes()
            digest = hashlib.sha256(data).hexdigest()
            index.setdefault(digest, []).append((name, transpose))

    files = {}
    for name in ["encoder.onnx", "encoder.onnx.data", "head.onnx", "head.onnx.data", "LICENSE.txt"]:
        expected = manifest["files"][name]
        if (ASSETS / name).stat().st_size != expected["bytes"] or checksum(ASSETS / name) != expected["sha256"]:
            raise ValueError(f"The exported file failed verification: {name}")
        files[name] = dict(expected)
    for model in ["encoder", "head"]:
        graph = onnx.load(str(ASSETS / f"{model}.onnx"), load_external_data=False)
        exported = np.memmap(ASSETS / f"{model}.onnx.data", dtype=np.uint8, mode="r")
        tensors = []
        for initializer in graph.graph.initializer:
            if not initializer.external_data:
                continue
            external = {item.key: item.value for item in initializer.external_data}
            if external["location"] != f"{model}.onnx.data":
                raise ValueError("An ONNX initializer refers to an unexpected file.")
            offset, length = int(external["offset"]), int(external["length"])
            digest = hashlib.sha256(exported[offset:offset + length]).hexdigest()
            candidates = index.get(digest, [])
            if not candidates:
                raise ValueError(f"No checkpoint tensor matches {model}: {initializer.name}")
            name, transpose = next((item for item in candidates if item[0] == initializer.name), candidates[0])
            source = header[name]
            if source["dtype"] != "F16":
                raise ValueError(f"Unsupported tensor data type: {name}")
            start, end = source["data_offsets"]
            if length != (end - start) * 2:
                raise ValueError(f"Unexpected exported tensor byte count: {name}")
            tensors.append({
                "name": name,
                "inputOffset": data_start + start,
                "inputBytes": end - start,
                "shape": source["shape"],
                "transpose": transpose,
                "outputOffset": offset,
                "outputBytes": length,
            })
        tensors.sort(key=lambda item: item["outputOffset"])
        end = 0
        for tensor in tensors:
            if tensor["outputOffset"] < end or np.any(exported[end:tensor["outputOffset"]]):
                raise ValueError("Unexpected overlapping tensors or nonzero padding.")
            end = tensor["outputOffset"] + tensor["outputBytes"]
        if np.any(exported[end:]):
            raise ValueError("Unexpected nonzero trailing padding.")
        files[f"{model}.onnx.data"]["tensors"] = tensors

    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ["encoder.onnx", "head.onnx", "LICENSE.txt"]:
        shutil.copyfile(ASSETS / name, OUTPUT / name)
    mapping = {
        "model": manifest["model"],
        "modelRevision": manifest["modelRevision"],
        "sourceRevision": manifest["sourceRevision"],
        "checkpoint": {"bytes": checkpoint.stat().st_size, "sha256": manifest["checkpointSha256"]},
        "files": files,
    }
    (OUTPUT / "mapping.json").write_text(json.dumps(mapping, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared conversion templates in {OUTPUT}")


if __name__ == "__main__":
    main()
