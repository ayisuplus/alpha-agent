"""Probe a real read-only UNO document view and its native window pixels."""
import ctypes as C
from ctypes import wintypes as W
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import uno
from com.sun.star.beans import PropertyValue
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("probe", pathlib.Path(__file__).with_name("lok-probe.py"))
probe = module_from_spec(spec)
spec.loader.exec_module(probe)


def prop(name, value):
    item = PropertyValue()
    item.Name, item.Value = name, value
    return item


def capture(hwnd, target):
    user32, gdi32 = C.windll.user32, C.windll.gdi32
    user32.GetDC.argtypes, user32.GetDC.restype = [W.HWND], W.HDC
    user32.ReleaseDC.argtypes = [W.HWND, W.HDC]
    user32.PrintWindow.argtypes, user32.PrintWindow.restype = [W.HWND, W.HDC, W.UINT], W.BOOL
    gdi32.CreateCompatibleDC.argtypes, gdi32.CreateCompatibleDC.restype = [W.HDC], W.HDC
    gdi32.CreateDIBSection.argtypes, gdi32.CreateDIBSection.restype = [W.HDC, C.c_void_p, W.UINT, C.POINTER(C.c_void_p), W.HANDLE, W.DWORD], W.HBITMAP
    gdi32.SelectObject.argtypes, gdi32.SelectObject.restype = [W.HDC, W.HGDIOBJ], W.HGDIOBJ
    gdi32.DeleteObject.argtypes = [W.HGDIOBJ]
    gdi32.DeleteDC.argtypes = [W.HDC]
    rect = W.RECT()
    user32.GetClientRect(W.HWND(hwnd), C.byref(rect))
    width, height = rect.right, rect.bottom
    info = __import__("struct").pack("<IiiHHIIiiII", 40, width, -height, 1, 32, 0, 0, 0, 0, 0, 0)
    screen = user32.GetDC(W.HWND(hwnd))
    dc = gdi32.CreateCompatibleDC(screen)
    bits = C.c_void_p()
    bitmap = gdi32.CreateDIBSection(screen, info, 0, C.byref(bits), None, 0)
    previous = gdi32.SelectObject(dc, bitmap)
    try:
        ok = user32.PrintWindow(W.HWND(hwnd), dc, 3)
        pixels = bytearray(C.string_at(bits.value, width * height * 4))
        pixels[3::4] = b"\xff" * (width * height)
        target.write_bytes(probe.png(width, height, pixels, True))
        return {"captureReturn": bool(ok), "width": width, "height": height, "uniqueBytes": len(set(pixels))}
    finally:
        gdi32.SelectObject(dc, previous)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(dc)
        user32.ReleaseDC(W.HWND(hwnd), screen)


program = pathlib.Path(r"C:\Program Files\LibreOffice\program")
source, output = pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
workspace = pathlib.Path(tempfile.mkdtemp(prefix="alpha-uno-native-view-"))
staged = workspace / source.name
shutil.copy2(source, staged)
pipe = "alpha_view_" + uuid.uuid4().hex
environment = {**os.environ, "SAL_DISABLE_SKIA": "1"}
startup = subprocess.STARTUPINFO()
startup.dwFlags, startup.wShowWindow = subprocess.STARTF_USESHOWWINDOW, 0
server_log = (output / "server.log").open("w", encoding="utf-8")
server = subprocess.Popen([str(program / "soffice.exe"), "-env:UserInstallation=" + (workspace / "profile").as_uri(),
    "--headless" if os.environ.get("UNO_VIEW_PROBE_HEADLESS") else "--invisible", "--nologo", "--nodefault", "--norestore", "--accept=pipe,name=" + pipe + ";urp;StarOffice.ServiceManager"],
    stdout=server_log, stderr=server_log, env=environment, startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)
print(json.dumps({"phase": "startServer", "pid": server.pid, "workspace": str(workspace)}), flush=True)
doc, desktop = None, None
try:
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    for attempt in range(200):
        try:
            context = resolver.resolve("uno:pipe,name=" + pipe + ";urp;StarOffice.ComponentContext")
            break
        except Exception as error:
            last_error = str(error)
            if server.poll() is not None:
                raise RuntimeError("UNO server exited: " + str(server.returncode))
            time.sleep(.1)
    else:
        raise RuntimeError("UNO connection failed: " + last_error)
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    print(json.dumps({"phase": "load", "workspace": str(workspace)}), flush=True)
    doc = desktop.loadComponentFromURL(staged.as_uri(), "_blank", 0, (
        prop("Hidden", True), prop("ReadOnly", not bool(os.environ.get("UNO_VIEW_PROBE_WRITE_NOTES"))),
        prop("MacroExecutionMode", uno.getConstantByName("com.sun.star.document.MacroExecMode.NEVER_EXECUTE")),
        prop("UpdateDocMode", uno.getConstantByName("com.sun.star.document.UpdateDocMode.NO_UPDATE")),
    ))
    controller = doc.CurrentController
    frame = controller.Frame
    window = frame.ContainerWindow
    print(json.dumps({"phase": "loaded", "readonly": doc.isReadonly(), "controller": controller.ImplementationName}), flush=True)
    frame.LayoutManager.Visible = False
    window.setPosSize(-32000, -32000, 900, 700, 15)
    window.setVisible(True)
    handle = window.getWindowHandle((), uno.getConstantByName("com.sun.star.lang.SystemDependent.SYSTEM_WIN32"))
    print(json.dumps({"phase": "window", "handle": handle}), flush=True)
    time.sleep(.5)
    result = {"workspace": str(workspace), "readonly": doc.isReadonly(), "windowHandle": handle}
    result["pixels"] = capture(handle, output / "native-uno-view.png")
    if doc.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
        result["sheets"] = [{"index": index, "name": sheet.Name, "visible": sheet.IsVisible} for index, sheet in enumerate(doc.Sheets)]
        cell = doc.Sheets.getByName("Visible").getCellRangeByName("B2")
        result["formula"] = cell.Formula
        result["result"] = cell.Value
        result["comment"] = cell.Annotation.String
        result["commentShape"] = cell.Annotation.getAnnotationShape().String
        result["cellPosition"] = {"x": cell.Position.X, "y": cell.Position.Y, "width": cell.Size.Width, "height": cell.Size.Height}
        result["annotations"] = [{"text": note.String, "author": note.Author,
            "date": note.Date, "column": note.Position.Column, "row": note.Position.Row}
            for note in doc.Sheets.getByName("Visible").Annotations]
        result["visibleRange"] = str(controller.getVisibleRange())
        controller.select(doc.Sheets.getByName("Visible").getCellRangeByName("A1:F25"))
        doc.storeToURL((output / "native-cell-range.png").as_uri(), (
            prop("FilterName", "calc_png_Export"), prop("Overwrite", False),
            prop("SelectionOnly", True), prop("FilterData", uno.Any("[]com.sun.star.beans.PropertyValue", (
                prop("PixelWidth", 900), prop("PixelHeight", 700),
            ))),
        ))
        print(json.dumps({"phase": "cellRangeRendered"}), flush=True)
        controller.setActiveSheet(doc.Sheets.getByName("Second"))
        time.sleep(.2)
        result["secondPixels"] = capture(handle, output / "native-uno-second.png")
    elif doc.supportsService("com.sun.star.presentation.PresentationDocument"):
        if os.environ.get("UNO_VIEW_PROBE_WRITE_NOTES"):
            for index, page in enumerate(doc.DrawPages):
                shapes = [shape for shape in page.NotesPage if shape.supportsService("com.sun.star.presentation.NotesShape")]
                if not shapes:
                    shape = doc.createInstance("com.sun.star.presentation.NotesShape")
                    page.NotesPage.add(shape)
                    shape.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1000, 1000))
                    shape.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 18000, 12000))
                    shapes.append(shape)
                for shape in shapes:
                    shape.String = "Native speaker note " + str(index + 1) + "\n中文第二段笔记"
            doc.storeToURL((output / "native-notes-deck.pptx").as_uri(),
                (prop("FilterName", "Impress MS PowerPoint 2007 XML"), prop("Overwrite", False)))
        result["slides"] = [page.Name for page in doc.DrawPages]
        result["notes"] = [shape.String for shape in doc.DrawPages.getByIndex(0).NotesPage if hasattr(shape, "String")]
        exporter = context.ServiceManager.createInstanceWithContext("com.sun.star.drawing.GraphicExportFilter", context)
        exporter.setSourceDocument(doc.DrawPages.getByIndex(0))
        result["nativeSlideRendered"] = exporter.filter((prop("URL", (output / "native-slide.png").as_uri()),
            prop("MediaType", "image/png"), prop("FilterData", uno.Any("[]com.sun.star.beans.PropertyValue", (prop("PixelWidth", 900), prop("PixelHeight", 700))))))
    (output / "observations.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"phase": "done", "output": str(output / "observations.json")}), flush=True)
finally:
    if doc:
        try:
            doc.close(True)
        except Exception:
            pass
    if desktop:
        try:
            desktop.terminate()
        except Exception:
            pass
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(server.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
