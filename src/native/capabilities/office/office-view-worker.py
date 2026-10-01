"""One persistent, read-only original document view in a private process.

Writer uses the pinned LibreOfficeKit ABI; Calc/Impress render their original UNO
models directly to native PNG buffers. Document copies are never saved, and no
PDF/HTML document conversion is used. JSON lines are the only public worker input.
"""
import argparse
import base64
import ctypes as C
from html.parser import HTMLParser
import json
import os
import pathlib
import struct
import subprocess
import sys
import time
import uuid
import zlib


class CommentText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, _):
        if tag in ("br", "p", "div"):
            self.parts.append("\n")


def api(instance, slot, result, *arguments):
    table = C.cast(instance, C.POINTER(C.c_void_p))[0]
    size = C.cast(table, C.POINTER(C.c_size_t))[0]
    if slot * C.sizeof(C.c_void_p) >= size:
        raise RuntimeError("LibreOfficeKit 缺少原格式预览接口（槽位 " + str(slot) + "）")
    address = C.cast(table, C.POINTER(C.c_void_p))[slot]
    if not address:
        raise RuntimeError("LibreOfficeKit 原格式预览接口为空")
    return C.CFUNCTYPE(result, C.c_void_p, *arguments)(address)


def encode_png(width, height, pixels, bgra):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    if bgra:
        pixels = bytearray(pixels)
        pixels[0::4], pixels[2::4] = pixels[2::4], pixels[0::4]
    rows = b"".join(b"\0" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


class View:
    def __init__(self, program, source, profile):
        os.environ["PATH"] = str(program) + os.pathsep + os.environ.get("PATH", "")
        os.environ["SAL_USE_VCLPLUGIN"] = "svp"
        # The normal background main loop is tested on the pinned Windows build.
        os.environ.pop("SAL_LOK_OPTIONS", None)
        self.directory = os.add_dll_directory(str(program))
        self.library = C.CDLL(str(program / "mergedlo.dll"))
        hook = self.library.libreofficekit_hook_2
        hook.argtypes, hook.restype = [C.c_char_p, C.c_char_p], C.c_void_p
        self.kit = hook(str(program).encode("utf-8"), profile.as_uri().encode("utf-8"))
        self.doc = None
        if not self.kit:
            raise RuntimeError("LibreOfficeKit 无法启动原格式预览")
        table = C.cast(C.cast(self.kit, C.POINTER(C.c_void_p))[0], C.POINTER(C.c_void_p))
        self.free = C.CFUNCTYPE(None, C.c_void_p)(table[5])
        self.state = {}
        self.callback_type = C.CFUNCTYPE(None, C.c_int, C.c_char_p, C.c_void_p)
        self.callback = self.callback_type(self.on_callback)
        api(self.kit, 6, None, self.callback_type, C.c_void_p)(self.kit, self.callback, None)
        self.doc = api(self.kit, 4, C.c_void_p, C.c_char_p, C.c_char_p)(
            self.kit, source.as_uri().encode("utf-8"), b"EnableMacrosExecution=false,Batch=true")
        if not self.doc:
            raise RuntimeError(self.string(self.kit, 3) or "LibreOffice 无法加载原文档")
        api(self.doc, 13, None, C.c_char_p)(self.doc, b"{}")
        view_id = api(self.doc, 29, C.c_int)(self.doc)
        api(self.doc, 73, None, C.c_int, C.c_bool)(self.doc, view_id, True)
        api(self.doc, 74, None, C.c_int, C.c_bool)(self.doc, view_id, False)
        api(self.doc, 81, None, C.c_int, C.c_bool)(self.doc, view_id, False)
        api(self.doc, 14, None, self.callback_type, C.c_void_p)(self.doc, self.callback, None)
        self.pump = self.library.unit_lok_process_events_to_idle
        self.pump.argtypes, self.pump.restype = [], None
        self.pump()

    def on_callback(self, kind, payload, _):
        if kind in (2, 17, 19, 34):
            self.state[kind] = payload.decode("utf-8") if payload else ""
        elif kind in (20, 21):
            # This preview never prompts or executes document macros/password flows.
            api(self.kit, 9, None, C.c_char_p, C.c_char_p)(self.kit, payload, None)

    def string(self, instance, slot, *args):
        pointer = api(instance, slot, C.c_void_p, *([C.c_char_p] if args else []))(instance, *args)
        return self.take_string(pointer)

    def take_string(self, pointer):
        if not pointer:
            return ""
        try:
            return C.string_at(pointer).decode("utf-8")
        finally:
            self.free(pointer)

    def size(self):
        width, height = C.c_long(), C.c_long()
        api(self.doc, 12, None, C.POINTER(C.c_long), C.POINTER(C.c_long))(self.doc, C.byref(width), C.byref(height))
        return width.value, height.value

    def change_part(self, part):
        if part is not None:
            count = api(self.doc, 4, C.c_int)(self.doc)
            if not isinstance(part, int) or part < 0 or part >= count:
                raise ValueError("Office 页或工作表编号超出范围")
            api(self.doc, 7, None, C.c_int)(self.doc, part)
            self.pump()

    def info(self):
        width, height = self.size()
        kind = ("text", "spreadsheet", "presentation", "drawing")[api(self.doc, 3, C.c_int)(self.doc)]
        parts = []
        for index in range(api(self.doc, 4, C.c_int)(self.doc)):
            name = self.take_string(api(self.doc, 8, C.c_void_p, C.c_int)(self.doc, index))
            parts.append({"index": index, "name": name})
        comments = json.loads(self.string(self.doc, 23, b".uno:ViewAnnotations") or "{}").get("comments", [])
        for comment in comments:
            if "html" in comment:
                text = CommentText()
                text.feed(comment["html"])
                comment["text"] = "".join(text.parts).strip()
        revisions = json.loads(self.string(self.doc, 23, b".uno:AcceptTrackedChanges") or "{}").get("redlines", [])
        return {"kind": kind, "parts": parts, "part": api(self.doc, 6, C.c_int)(self.doc),
                "width": width, "height": height, "readOnly": True, "comments": comments,
                "revisions": revisions, "pageRectangles": self.string(self.doc, 5)}

    def render(self, options):
        self.change_part(options.get("part"))
        x, y = options.get("x", 0), options.get("y", 0)
        width, height, scale = options.get("width", 800), options.get("height", 600), options.get("scale", 1)
        twip_width, twip_height = round(width * 15 / scale), round(height * 15 / scale)
        api(self.doc, 24, None, *([C.c_int] * 4))(self.doc, width, height, twip_width, twip_height)
        api(self.doc, 25, None, *([C.c_int] * 4))(self.doc, x, y, twip_width, twip_height)
        pixels = (C.c_ubyte * (width * height * 4))()
        api(self.doc, 10, None, C.POINTER(C.c_ubyte), *([C.c_int] * 6))(
            self.doc, pixels, width, height, x, y, twip_width, twip_height)
        image = encode_png(width, height, bytes(pixels), api(self.doc, 11, C.c_int)(self.doc) == 1)
        document_width, document_height = self.size()
        return {"image": base64.b64encode(image).decode("ascii"), "mimeType": "image/png",
                "part": api(self.doc, 6, C.c_int)(self.doc), "width": width, "height": height,
                "documentWidth": document_width, "documentHeight": document_height}

    def select(self, options):
        self.change_part(options.get("part"))
        count = options.get("count", 1)
        mouse = api(self.doc, 16, None, *([C.c_int] * 6))
        for kind in (0, 1):
            mouse(self.doc, kind, options["x"], options["y"], count, 1, 0)
        self.pump()
        used_mime = C.c_void_p()
        pointer = api(self.doc, 19, C.c_void_p, C.c_char_p, C.POINTER(C.c_void_p))(
            self.doc, b"text/plain;charset=utf-8", C.byref(used_mime))
        selection = self.take_string(pointer)
        self.take_string(used_mime.value)
        width, height = self.size()
        result = {"selection": selection, "part": api(self.doc, 6, C.c_int)(self.doc), "width": width, "height": height}
        if 19 in self.state:
            result["formula"] = self.state[19]
        if 34 in self.state:
            result["cellAddress"] = self.state[34]
        return result

    def close(self):
        if self.doc:
            api(self.doc, 1, None)(self.doc)
            self.doc = None
        if self.kit:
            api(self.kit, 1, None)(self.kit)
            self.kit = None


def crop_native_png(data, x, y, width, height):
    """Crop the native engine's PNG buffer without changing its document content."""
    offset, compressed = 8, bytearray()
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind, body = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + length]
        if kind == b"IHDR":
            source_width, source_height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or color not in (2, 6) or interlace or max(source_width, source_height) > 4097:
                raise RuntimeError("LibreOffice 原生位图格式或尺寸超出已验证范围")
        elif kind == b"IDAT":
            compressed.extend(body)
        offset += length + 12
    channels = 4 if color == 6 else 3
    stride = source_width * channels
    raw, previous = zlib.decompress(compressed), bytearray(stride)
    pixels = bytearray(b"\xff" * (width * height * 4))
    for row in range(source_height):
        start = row * (stride + 1)
        method, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for index in range(stride) if method else ():
            left = line[index - channels] if index >= channels else 0
            above = previous[index]
            corner = previous[index - channels] if index >= channels else 0
            if method == 1:
                predictor = left
            elif method == 2:
                predictor = above
            elif method == 3:
                predictor = (left + above) // 2
            elif method == 4:
                estimate = left + above - corner
                distances = [abs(estimate - left), abs(estimate - above), abs(estimate - corner)]
                predictor = (left, above, corner)[distances.index(min(distances))]
            else:
                raise RuntimeError("LibreOffice 原生 PNG 使用了未知行过滤器")
            line[index] = (line[index] + predictor) & 255
        previous = line
        if not y <= row < y + height:
            continue
        left, right = max(0, x), min(source_width, x + width)
        if right > left:
            segment = line[left * channels:right * channels]
            if channels == 3:
                rgba = bytearray(b"\xff" * ((right - left) * 4))
                rgba[0::4], rgba[1::4], rgba[2::4] = segment[0::3], segment[1::3], segment[2::3]
                segment = rgba
            target = ((row - y) * width + left - x) * 4
            pixels[target:target + len(segment)] = segment
    return encode_png(width, height, pixels, False)


class UnoView:
    """Persistent original Calc/Impress model, rendered by LibreOffice itself."""
    def __init__(self, program, source, profile):
        import uno
        from com.sun.star.beans import PropertyValue
        self.uno, self.property_type = uno, PropertyValue
        self.source, self.server, self.doc, self.desktop = source, None, None, None
        self.part = 0
        pipe = "alpha_office_view_" + uuid.uuid4().hex
        startup = subprocess.STARTUPINFO()
        startup.dwFlags, startup.wShowWindow = subprocess.STARTF_USESHOWWINDOW, 0
        self.server = subprocess.Popen([str(program / "soffice.exe"), "-env:UserInstallation=" + profile.as_uri(),
            "--headless", "--nologo", "--nodefault", "--norestore",
            "--accept=pipe,name=" + pipe + ";urp;StarOffice.ServiceManager"],
            stdout=subprocess.DEVNULL, stderr=sys.stderr, startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW,
            env={**os.environ, "SAL_DISABLE_SKIA": "1"})
        try:
            local = uno.getComponentContext()
            resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
            for attempt in range(150):
                try:
                    self.context = resolver.resolve("uno:pipe,name=" + pipe + ";urp;StarOffice.ComponentContext")
                    break
                except Exception:
                    if self.server.poll() is not None:
                        raise RuntimeError("LibreOffice 原格式视图进程已退出")
                    time.sleep(.1)
            else:
                raise RuntimeError("LibreOffice 原格式视图连接超时")
            self.desktop = self.service("com.sun.star.frame.Desktop")
            self.doc = self.desktop.loadComponentFromURL(source.as_uri(), "_blank", 0, (
                self.prop("Hidden", True), self.prop("ReadOnly", True),
                self.prop("MacroExecutionMode", uno.getConstantByName("com.sun.star.document.MacroExecMode.NEVER_EXECUTE")),
                self.prop("UpdateDocMode", uno.getConstantByName("com.sun.star.document.UpdateDocMode.NO_UPDATE")),
            ))
            if not self.doc or not self.doc.isReadonly():
                raise RuntimeError("LibreOffice 未能以只读方式加载原文档")
            self.controller = self.doc.CurrentController
            self.kind = "spreadsheet" if self.doc.supportsService("com.sun.star.sheet.SpreadsheetDocument") else "presentation"
            self.parts = list(self.doc.Sheets if self.kind == "spreadsheet" else self.doc.DrawPages)
            if self.kind == "spreadsheet":
                self.part = next(index for index, sheet in enumerate(self.parts) if sheet.Name == self.controller.ActiveSheet.Name)
        except Exception:
            self.close()
            raise

    def prop(self, name, value):
        result = self.property_type()
        result.Name, result.Value = name, value
        return result

    def service(self, name):
        return self.context.ServiceManager.createInstanceWithContext(name, self.context)

    def filter_data(self, width, height):
        return self.uno.Any("[]com.sun.star.beans.PropertyValue", (self.prop("PixelWidth", width), self.prop("PixelHeight", height)))

    def size(self):
        item = self.parts[self.part]
        if self.kind == "spreadsheet":
            cursor = item.createCursor()
            cursor.gotoEndOfUsedArea(True)
            bounds = cursor.Size
            return max(1, round(bounds.Width * 72 / 127)), max(1, round(bounds.Height * 72 / 127))
        return round(item.Width * 72 / 127), round(item.Height * 72 / 127)

    def change_part(self, part):
        if part is None:
            return
        if not isinstance(part, int) or part < 0 or part >= len(self.parts):
            raise ValueError("Office 页或工作表编号超出范围")
        item = self.parts[part]
        if self.kind == "spreadsheet":
            if not item.IsVisible:
                raise ValueError("此工作表在原文档中处于隐藏状态；只读预览保留隐藏状态，请在原应用中查看")
            self.controller.setActiveSheet(item)
        else:
            self.controller.setCurrentPage(item)
        self.part = part

    def info(self):
        width, height = self.size()
        parts = [{"index": index, "name": item.Name} for index, item in enumerate(self.parts)]
        comments, notes = [], []
        for index, item in enumerate(self.parts):
            if self.kind == "spreadsheet":
                parts[index]["hidden"] = not item.IsVisible
                for annotation in item.Annotations:
                    # Calc materializes imported note text when creating its native caption.
                    shape = annotation.getAnnotationShape()
                    cell = item.getCellByPosition(annotation.Position.Column, annotation.Position.Row)
                    comments.append({"part": index, "cellAddress": cell.AbsoluteName.split(".")[-1].replace("$", ""),
                        "author": annotation.Author, "date": annotation.Date,
                        "text": shape.String if shape else annotation.String})
            else:
                for shape in item.NotesPage:
                    if hasattr(shape, "String") and shape.String:
                        notes.append({"part": index, "text": shape.String})
                if hasattr(item, "createAnnotationEnumeration"):
                    enumeration = item.createAnnotationEnumeration()
                    while enumeration.hasMoreElements():
                        annotation = enumeration.nextElement()
                        comments.append({"part": index, "author": annotation.Author, "text": annotation.TextRange.String})
        return {"kind": self.kind, "parts": parts, "part": self.part, "width": width, "height": height,
            "readOnly": True, "comments": comments, "revisions": [], "notes": notes}

    def cell_at(self, sheet, coordinate, axis):
        low, high = 0, (sheet.Columns.Count if axis == "x" else sheet.Rows.Count) - 1
        target = coordinate * 127 / 72
        while low < high:
            middle = (low + high + 1) // 2
            cell = sheet.getCellByPosition(middle, 0) if axis == "x" else sheet.getCellByPosition(0, middle)
            position = cell.Position.X if axis == "x" else cell.Position.Y
            if position <= target:
                low = middle
            else:
                high = middle - 1
        return low

    def render(self, options):
        self.change_part(options.get("part"))
        x, y = options.get("x", 0), options.get("y", 0)
        width, height, scale = options.get("width", 800), options.get("height", 600), options.get("scale", 1)
        item, output = self.parts[self.part], self.source.parent / "native-tile.png"
        if output.exists():
            output.unlink()
        if self.kind == "spreadsheet":
            left, top = self.cell_at(item, x, "x"), self.cell_at(item, y, "y")
            right = self.cell_at(item, x + width * 15 / scale, "x")
            bottom = self.cell_at(item, y + height * 15 / scale, "y")
            region = item.getCellRangeByPosition(left, top, right, bottom)
            self.controller.select(region)
            origin_x, origin_y = region.Position.X * 72 / 127, region.Position.Y * 72 / 127
            pixel_width = max(1, round(region.Size.Width * 72 / 127 * scale / 15))
            pixel_height = max(1, round(region.Size.Height * 72 / 127 * scale / 15))
        else:
            origin_x = origin_y = 0
            document_width, document_height = self.size()
            pixel_width, pixel_height = max(1, round(document_width * scale / 15)), max(1, round(document_height * scale / 15))
        if max(pixel_width, pixel_height) > 4096:
            raise ValueError("此原生区域位图超出已验证尺寸，请缩小后预览或在原应用中查看")
        if self.kind == "spreadsheet":
            self.doc.storeToURL(output.as_uri(), (self.prop("FilterName", "calc_png_Export"),
                self.prop("Overwrite", False), self.prop("SelectionOnly", True),
                self.prop("FilterData", self.filter_data(pixel_width, pixel_height))))
        else:
            exporter = self.service("com.sun.star.drawing.GraphicExportFilter")
            exporter.setSourceDocument(item)
            if not exporter.filter((self.prop("URL", output.as_uri()), self.prop("MediaType", "image/png"),
                self.prop("FilterData", self.filter_data(pixel_width, pixel_height)))):
                raise RuntimeError("LibreOffice 未能绘制原幻灯片")
        image = crop_native_png(output.read_bytes(), round((x - origin_x) * scale / 15),
            round((y - origin_y) * scale / 15), width, height)
        document_width, document_height = self.size()
        return {"image": base64.b64encode(image).decode("ascii"), "mimeType": "image/png", "part": self.part,
            "width": width, "height": height, "documentWidth": document_width, "documentHeight": document_height}

    def select(self, options):
        self.change_part(options.get("part"))
        item, text = self.parts[self.part], ""
        width, height = self.size()
        result = {"part": self.part, "width": width, "height": height}
        if self.kind == "spreadsheet":
            cell = item.getCellByPosition(self.cell_at(item, options["x"], "x"), self.cell_at(item, options["y"], "y"))
            self.controller.select(cell)
            text = cell.String
            result.update({"formula": cell.Formula, "cellAddress": cell.AbsoluteName.split(".")[-1].replace("$", "")})
        else:
            x, y = options["x"] * 127 / 72, options["y"] * 127 / 72
            for shape in reversed(list(item)):
                if shape.Position.X <= x <= shape.Position.X + shape.Size.Width and shape.Position.Y <= y <= shape.Position.Y + shape.Size.Height:
                    self.controller.select(shape)
                    text = shape.String if hasattr(shape, "String") else ""
                    break
        result["selection"] = text
        return result

    def close(self):
        for component, method in ((self.doc, "close"), (self.desktop, "terminate")):
            if component:
                try:
                    getattr(component, method)(True) if method == "close" else getattr(component, method)()
                except Exception:
                    pass
        if self.server and self.server.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.server.pid)], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)


def respond(seq, result=None, error=None):
    print(json.dumps({"seq": seq, "ok": error is None, "result": result, "error": error}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--program", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    view = None
    try:
        source = pathlib.Path(args.input)
        view_type = UnoView if source.suffix.lower() in (".xlsx", ".ods", ".pptx", ".odp") else View
        view = view_type(pathlib.Path(args.program), source, pathlib.Path(args.profile))
        respond(0, view.info())
        for line in sys.stdin:
            request = json.loads(line)
            seq = request["seq"]
            try:
                action = request["action"]
                if action == "info":
                    respond(seq, view.info())
                elif action == "render":
                    respond(seq, view.render(request.get("options", {})))
                elif action == "select":
                    respond(seq, view.select(request["options"]))
                else:
                    raise ValueError("未知 Office 只读预览动作")
            except Exception as error:
                respond(seq, error=str(error))
    except Exception as error:
        respond(0, error=str(error))
        sys.exit(1)
    finally:
        if view:
            view.close()
