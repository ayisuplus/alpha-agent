"""Read PE exports without loading or modifying the installed engine."""
import hashlib
import json
import pathlib
import struct
import sys


def exports(path):
    blob = pathlib.Path(path).read_bytes()
    pe = struct.unpack_from("<I", blob, 0x3C)[0]
    sections_count, optional_size = struct.unpack_from("<H12xH", blob, pe + 6)
    optional = pe + 24
    magic = struct.unpack_from("<H", blob, optional)[0]
    directory = optional + (112 if magic == 0x20B else 96)
    export_rva, export_size = struct.unpack_from("<II", blob, directory)
    sections = []
    for index in range(sections_count):
        position = optional + optional_size + index * 40
        virtual_size, rva, raw_size, raw = struct.unpack_from("<IIII", blob, position + 8)
        sections.append((rva, max(virtual_size, raw_size), raw))

    def offset(rva):
        for start, length, raw in sections:
            if start <= rva < start + length:
                return raw + rva - start
        return rva

    if not export_rva:
        return []
    count, names_rva = struct.unpack_from("<I4xI", blob, offset(export_rva) + 24)
    names = []
    for index in range(count):
        string_rva = struct.unpack_from("<I", blob, offset(names_rva) + index * 4)[0]
        start = offset(string_rva)
        names.append(blob[start:blob.index(b"\0", start)].decode("ascii"))
    return names


if __name__ == "__main__":
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Program Files\LibreOffice\program")
    result = []
    for name in ("mergedlo.dll", "sofficeapp.dll", "sclo.dll", "swlo.dll", "sdlo.dll", "vclplug_winlo.dll"):
        path = root / name
        if not path.exists():
            result.append({"path": str(path), "exists": False})
            continue
        names = exports(path)
        result.append({"path": str(path), "exists": True,
                       "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                       "exportCount": len(names),
                       "lokExports": [name for name in names if any(token in name.lower() for token in ("libreofficekit", "lok_", "tiled"))]})
    print(json.dumps(result, indent=2))
