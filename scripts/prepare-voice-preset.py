"""Freeze a current-API copy of the user's VoxCPM2 voice-design workflow."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"G:\comfyui\ComfyUI\ComfyUI\user\default\workflows\VoxCPM2\01-VoxCPM2-中文配音与声音设计.json")
OUT = ROOT / "presets" / "voxcpm2-voice.api.json"


def main() -> None:
    source_bytes = SOURCE.read_bytes()
    source = json.loads(source_bytes)
    nodes = {str(node["id"]): node for node in source["nodes"]}
    if nodes["24"]["type"] != "VoxCPM_TTS" or nodes["1"]["type"] != "SaveAudio" or [43, 24, 0, 1, 0, "AUDIO"] not in source["links"]:
        raise ValueError("Voice workflow structure changed")
    values = nodes["24"]["widgets_values"]
    if len(values) != 13 or values[0] != values[1]:
        raise ValueError("Voice workflow widget layout changed")
    names = ["model_name", "lora_name", "text", "voice_design", "cfg", "steps", "normalize_text", "seed", "force_offload", "device", "dtype"]
    inputs = dict(zip(names, [values[i] for i in [0, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12]], strict=True))
    graph = {
        "24": {"class_type": "VoxCPM_TTS", "inputs": inputs},
        "1": {"class_type": "SaveAudio", "inputs": {"audio": ["24", 0], "filename_prefix": "Alpha/voice"}},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT.parent / "voxcpm2-voice.provenance.json").write_text(json.dumps({
        "source": str(SOURCE),
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "transform": "Map the saved UI workflow's duplicate model widget to the current VoxCPM_TTS API input schema; preserve audio settings; omit documentation node.",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(OUT))


if __name__ == "__main__":
    main()
