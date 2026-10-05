"""Original-format LibreOfficeKit probe using only Python stdlib and local DLLs."""
import ctypes as C
import hashlib
import json
import os
import pathlib
import shutil
import struct
import sys
import tempfile
import concurrent.futures
from ctypes import wintypes
import zlib


def function(instance, slot, restype, *argtypes):
    table = C.cast(instance, C.POINTER(C.c_void_p))[0]
    size = C.cast(table, C.POINTER(C.c_size_t))[0]
    if slot * C.sizeof(C.c_void_p) >= size:
        raise RuntimeError("Missing LOK API slot " + str(slot))
    address = C.cast(table, C.POINTER(C.c_void_p))[slot]
    return C.CFUNCTYPE(restype, C.c_void_p, *argtypes)(address)


def png(width, height, pixels, bgra):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    if bgra:
        rgba = bytearray(pixels)
        rgba[0::4], rgba[2::4] = rgba[2::4], rgba[0::4]
        pixels = rgba
    rows = b"".join(b"\0" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    program = pathlib.Path(r"C:\Program Files\LibreOffice\program")
    input_path = pathlib.Path(sys.argv[1]).resolve()
    output = pathlib.Path(sys.argv[2]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="alpha-lok-probe-"))
    profile = workspace / "profile"
    staged = workspace / input_path.name
    shutil.copy2(input_path, staged)
    os.environ["PATH"] = str(program) + os.pathsep + os.environ.get("PATH", "")
    os.environ["SAL_USE_VCLPLUGIN"] = "svp"
    dll_directory = os.add_dll_directory(str(program))
    print(json.dumps({"phase": "loadLibrary", "workspace": str(workspace)}), flush=True)
    library = C.CDLL(str(program / "mergedlo.dll"))
    hook = library.libreofficekit_hook_2
    hook.argtypes = [C.c_char_p, C.c_char_p]
    hook.restype = C.c_void_p
    print(json.dumps({"phase": "initialize"}), flush=True)
    kit = hook(str(program).encode(), profile.as_uri().encode())
    if not kit:
        raise RuntimeError("libreofficekit_hook_2 returned null")
    free_string = C.CFUNCTYPE(None, C.c_void_p)(C.cast(C.cast(kit, C.POINTER(C.c_void_p))[0], C.POINTER(C.c_void_p))[5])

    def string(instance, slot, *args):
        fn = function(instance, slot, C.c_void_p, *([C.c_char_p] if args else []))
        value = fn(instance, *args)
        if not value:
            return None
        result = C.string_at(value).decode("utf-8")
        free_string(value)
        return result

    events = []
    callback_type = C.CFUNCTYPE(None, C.c_int, C.c_char_p, C.c_void_p)
    def receive(kind, payload, _):
        event = {"type": kind, "payload": payload.decode("utf-8") if payload else None}
        events.append(event)
        if kind in (9, 10, 11, 20, 21, 22):
            print(json.dumps({"phase": "engineCallback", **event}), flush=True)
    callback = callback_type(receive)
    function(kit, 6, None, callback_type, C.c_void_p)(kit, callback, None)
    print(json.dumps({"phase": "loadDocument", "version": string(kit, 10)}), flush=True)
    if os.environ.get("LOK_PROBE_PUMP"):
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = pool.submit(function(kit, 4, C.c_void_p, C.c_char_p, C.c_char_p), kit, staged.as_uri().encode(), b"EnableMacrosExecution=false")
        message = wintypes.MSG()
        while not future.done():
            while C.windll.user32.PeekMessageW(C.byref(message), None, 0, 0, 1):
                C.windll.user32.TranslateMessage(C.byref(message))
                C.windll.user32.DispatchMessageW(C.byref(message))
            __import__("time").sleep(.01)
        doc = future.result()
        pool.shutdown()
    else:
        doc = function(kit, 4, C.c_void_p, C.c_char_p, C.c_char_p)(kit, staged.as_uri().encode(), b"EnableMacrosExecution=false")
    if not doc:
        raise RuntimeError("documentLoad: " + str(string(kit, 3)))
    function(doc, 13, None, C.c_char_p)(doc, b"{}")
    function(doc, 14, None, callback_type, C.c_void_p)(doc, callback, None)
    width, height = C.c_long(), C.c_long()
    function(doc, 12, None, C.POINTER(C.c_long), C.POINTER(C.c_long))(doc, C.byref(width), C.byref(height))
    parts = function(doc, 4, C.c_int)(doc)
    part_names = []
    for part in range(parts):
        pointer = function(doc, 8, C.c_void_p, C.c_int)(doc, part)
        part_names.append(C.string_at(pointer).decode("utf-8"))
        free_string(pointer)
    mode = function(doc, 11, C.c_int)(doc)
    print(json.dumps({"phase": "paintTile", "size": [width.value, height.value], "parts": part_names, "tileMode": mode}), flush=True)
    buffer = (C.c_ubyte * (800 * 600 * 4))()
    function(doc, 10, None, C.POINTER(C.c_ubyte), *([C.c_int] * 6))(doc, buffer, 800, 600, 0, 0, 12000, 9000)
    image = png(800, 600, bytes(buffer), mode == 1)
    (output / "native-tile.png").write_bytes(image)
    command_values = {}
    for command in (b".uno:ViewAnnotations", b".uno:AcceptTrackedChanges", b".uno:ReadOnly"):
        command_values[command.decode()] = string(doc, 23, command)
    result = {"input": str(input_path), "staged": str(staged), "workspace": str(workspace),
              "version": string(kit, 10), "kind": function(doc, 3, C.c_int)(doc),
              "parts": part_names, "size": [width.value, height.value], "tileMode": mode,
              "png": str(output / "native-tile.png"), "pngSha256": hashlib.sha256(image).hexdigest(),
              "commands": command_values, "events": events,
              "originalSha256": hashlib.sha256(input_path.read_bytes()).hexdigest()}
    (output / "observations.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    function(doc, 1, None)(doc)
    function(kit, 1, None)(kit)
    print(json.dumps({"phase": "done", "output": str(output / "observations.json")}), flush=True)
