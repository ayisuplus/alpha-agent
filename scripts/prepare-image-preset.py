"""Freeze a small, neutral API copy of the user's validated Flux2 image workflow."""

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

from comfy_cli.workflow_to_api import convert_ui_to_api


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"G:\comfyui\ComfyUI\ComfyUI\user\default\workflows\flux2文生图.json")
OUT = ROOT / "presets" / "flux2-image.api.json"


def main() -> None:
    source_bytes = SOURCE.read_bytes()
    with urlopen("http://127.0.0.1:8188/object_info", timeout=15) as response:
        object_info = json.load(response)
    graph = convert_ui_to_api(json.loads(source_bytes), object_info)
    expected = {"13": "UNETLoader", "17": "VAEDecode", "18": "KSampler", "19": "CLIPTextEncode", "31": "SaveImage"}
    for node_id, class_type in expected.items():
        if graph.get(node_id, {}).get("class_type") != class_type:
            raise ValueError(f"Source workflow changed at node {node_id}")

    # This personal workflow's influencer LoRA is unrelated to general product art.
    graph["18"]["inputs"]["model"] = ["13", 0]
    graph["17"]["inputs"]["samples"] = ["18", 0]
    graph["31"]["inputs"]["images"] = ["17", 0]
    graph["19"]["inputs"]["text"] = "Original product illustration"
    graph["28"]["inputs"]["FLUX"] = "1024×1024 (1:1)"
    graph["31"]["inputs"]["filename_prefix"] = "Alpha"

    # Keep only nodes that feed the final saved image. The original remains untouched.
    keep = set()

    def visit(node_id: str) -> None:
        if node_id in keep:
            return
        keep.add(node_id)
        for value in graph[node_id]["inputs"].values():
            if isinstance(value, list) and value and isinstance(value[0], str) and value[0] in graph:
                visit(value[0])

    visit("31")
    graph = {key: value for key, value in graph.items() if key in keep}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT.parent / "flux2-image.provenance.json").write_text(json.dumps({
        "source": str(SOURCE),
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "transform": "Convert UI to API; bypass personal LoRA and cleanup nodes; retain saved-image dependency graph; neutralize prompt; use square Flux2 size.",
        "nodeCount": len(graph),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"preset": str(OUT), "nodes": len(graph)}))


if __name__ == "__main__":
    main()
