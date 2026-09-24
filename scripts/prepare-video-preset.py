"""Freeze the approved local H3/FlashVSR chain without its external prompt API."""

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

from comfy_cli.workflow_to_api import convert_ui_to_api


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"G:\comfyui\ComfyUI\ComfyUI\user\default\workflows\默认视频-Minimax-H3全能参考-8步-FlashVSR.json")
OUT = ROOT / "presets" / "h3-video.api.json"


def main() -> None:
    source_bytes = SOURCE.read_bytes()
    with urlopen("http://127.0.0.1:8188/object_info", timeout=15) as response:
        object_info = json.load(response)
    graph = convert_ui_to_api(json.loads(source_bytes), object_info)
    expected = {"14": "LoadImage", "16": "MiniMaxH3ReferenceToVideo", "33": "VHS_VideoCombine", "44": "VHS_VideoCombine", "54": "VHS_VideoCombine", "57": "VHS_VideoCombine"}
    for node_id, class_type in expected.items():
        if graph.get(node_id, {}).get("class_type") != class_type:
            raise ValueError(f"Video workflow changed at node {node_id}")
    pinned = [
        ("1", "unet_name", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"),
        ("2", "lora_name", "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"),
        ("2", "strength_model", 1),
        ("13", "steps", 8),
        ("17", "megapixels", 1),
        ("32", "scale", 2),
        ("43", "shift_video", 6),
        ("43", "shift_audio", 3),
    ]
    for node_id, field, value in pinned:
        if graph.get(node_id, {}).get("inputs", {}).get(field) != value:
            raise ValueError(f"Approved video setting changed: {node_id}.{field}")
    graph["16"]["inputs"]["prompt"] = "<Picture 1> is the sole reference. Make a short coherent shot that preserves its subject and composition. No text or scene cuts."
    for node_id, label in [("33", "final"), ("44", "native"), ("54", "flashvsr"), ("57", "native-full")]:
        graph[node_id]["inputs"]["filename_prefix"] = f"Alpha/video-{label}"

    keep = set()

    def visit(node_id: str) -> None:
        if node_id in keep:
            return
        keep.add(node_id)
        for value in graph[node_id]["inputs"].values():
            if isinstance(value, list) and value and isinstance(value[0], str) and value[0] in graph:
                visit(value[0])

    for output_id in ("33", "44", "54", "57"):
        visit(output_id)
    graph = {key: value for key, value in graph.items() if key in keep}
    if {"47", "48", "49"} & keep:
        raise ValueError("External prompt-enhancement branch remains connected")
    serialized = json.dumps(graph, ensure_ascii=False, indent=2) + "\n"
    if "api_key" in serialized or "api.deepseek.com" in serialized:
        raise ValueError("External API configuration survived sanitization")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(serialized, encoding="utf-8")
    (OUT.parent / "h3-video.provenance.json").write_text(json.dumps({
        "source": str(SOURCE),
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "transform": "Bypass external prompt enhancer and remove unreachable nodes; retain approved H3 and FlashVSR chain and four diagnostic outputs.",
        "nodeCount": len(graph),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"preset": str(OUT), "nodes": len(graph)}))


if __name__ == "__main__":
    main()
