"""Run one LibreOffice document job with the Python/UNO shipped by LibreOffice."""

import json
import pathlib
import sys
import time
import zipfile

import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def url(path):
    return uno.systemPathToFileUrl(str(pathlib.Path(path).resolve()))


def check_features(path, extension):
    blocked = []
    if extension not in ("docx", "xlsx", "pptx"):
        return blocked
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        tests = {
            "docx": [("word/vbaProject.bin", "macro"), ("word/embeddings/", "embedded object")],
            "xlsx": [("xl/vbaProject.bin", "macro"), ("xl/pivotTables/", "pivot table"),
                     ("xl/externalLinks/", "external link"), ("xl/connections.xml", "data connection"),
                     ("xl/slicerCaches/", "slicer"), ("xl/charts/", "chart")],
            "pptx": [("ppt/vbaProject.bin", "macro"), ("ppt/embeddings/", "embedded object"),
                     ("ppt/diagrams/", "SmartArt"), ("ppt/charts/", "embedded chart")],
        }[extension]
        for prefix, label in tests:
            if any(name.startswith(prefix) for name in names):
                blocked.append(label)
        if extension == "docx":
            document = archive.read("word/document.xml")
            if b"<w:ins" in document or b"<w:del" in document:
                blocked.append("tracked changes")
        if extension == "pptx":
            if any(b"<p:anim" in archive.read(name) for name in names
                   if name.startswith("ppt/slides/slide") and name.endswith(".xml")):
                blocked.append("animation")
    return sorted(set(blocked))


def entries(container):
    enum = container.createEnumeration()
    while enum.hasMoreElements():
        yield enum.nextElement()


def word_paragraphs(doc):
    return [item for item in entries(doc.Text) if item.supportsService("com.sun.star.text.Paragraph")]


def inspect_doc(doc, extension):
    if extension == "docx":
        paragraphs = [{"index": index, "text": item.String} for index, item in enumerate(word_paragraphs(doc))]
        tables = []
        for table in doc.TextTables:
            cells = [{"address": name, "text": table.getCellByName(name).String} for name in table.CellNames]
            tables.append({"name": table.Name, "cells": cells})
        return {"paragraphs": paragraphs, "tables": tables}
    if extension == "xlsx":
        sheets = []
        for sheet in doc.Sheets:
            cursor = sheet.createCursor()
            cursor.gotoEndOfUsedArea(True)
            last_row = min(cursor.RangeAddress.EndRow, 199)
            last_column = min(cursor.RangeAddress.EndColumn, 49)
            cells = []
            for row in range(last_row + 1):
                for column in range(last_column + 1):
                    cell = sheet.getCellByPosition(column, row)
                    if cell.String or cell.Formula:
                        cells.append({"address": cell.AbsoluteName.rsplit(".", 1)[-1].replace("$", ""),
                                      "text": cell.String, "formula": cell.Formula if cell.Formula.startswith("=") else None,
                                      "value": cell.Value})
            sheets.append({"name": sheet.Name, "cells": cells, "truncated": cursor.RangeAddress.EndRow > last_row or cursor.RangeAddress.EndColumn > last_column})
        return {"sheets": sheets}
    slides = []
    for page_index in range(doc.DrawPages.Count):
        page = doc.DrawPages.getByIndex(page_index)
        shapes = []
        for shape_index in range(page.Count):
            shape = page.getByIndex(shape_index)
            text = shape.String if hasattr(shape, "String") else ""
            shapes.append({"index": shape_index, "type": shape.ShapeType, "text": text})
        slides.append({"index": page_index, "shapes": shapes})
    return {"slides": slides}


def replace_text(text, expected, replacement, paragraph=None):
    original = paragraph.String if paragraph is not None else text.String
    if not expected or original.count(expected) != 1:
        raise ValueError("Expected text must occur exactly once in the selected object")
    start = original.index(expected)
    cursor = text.createTextCursorByRange(paragraph.getStart()) if paragraph is not None else text.createTextCursor()
    if paragraph is None:
        cursor.gotoStart(False)
    cursor.goRight(start, False)
    cursor.goRight(len(expected), True)
    cursor.setString(replacement)


def edit_doc(doc, extension, edits):
    if not isinstance(edits, list) or not edits or len(edits) > 100:
        raise ValueError("Provide 1-100 targeted edits")
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError("Each edit must be an object")
        if extension == "docx":
            if "table" in edit:
                cell = doc.TextTables.getByName(edit["table"]).getCellByName(edit["cell"])
                replace_text(cell.Text, edit["expected"], edit["replacement"])
            else:
                if not isinstance(edit.get("paragraph"), int) or edit["paragraph"] < 0:
                    raise ValueError("Invalid paragraph index")
                paragraph = word_paragraphs(doc)[edit["paragraph"]]
                replace_text(doc.Text, edit["expected"], edit["replacement"], paragraph)
        elif extension == "xlsx":
            cell = doc.Sheets.getByName(edit["sheet"]).getCellRangeByName(edit["cell"])
            current = cell.Formula if cell.Formula.startswith("=") else cell.String
            if current != edit["expected"]:
                raise ValueError("Cell changed since inspection")
            replacement = edit["replacement"]
            if isinstance(replacement, (int, float)):
                cell.Value = replacement
            elif isinstance(replacement, str) and replacement.startswith("="):
                cell.Formula = replacement
            elif isinstance(replacement, str):
                cell.String = replacement
            else:
                raise ValueError("Unsupported cell replacement")
        else:
            if any(not isinstance(edit.get(key), int) or edit[key] < 0 for key in ("slide", "shape")):
                raise ValueError("Invalid slide or shape index")
            page = doc.DrawPages.getByIndex(edit["slide"])
            shape = page.getByIndex(edit["shape"])
            if "image" in edit:
                if not shape.PropertySetInfo.hasPropertyByName("GraphicURL"):
                    raise ValueError("Selected shape is not an image")
                shape.GraphicURL = url(edit["image"])
            else:
                replace_text(shape, edit["expected"], edit["replacement"])
    if extension == "xlsx":
        doc.calculateAll()


def run(job):
    extension = job["format"]
    blocked = check_features(job["input"], extension)
    if blocked and job["mode"] == "edit":
        raise ValueError("Editing paused for unsupported features: " + ", ".join(blocked))
    connection = job["connection"]
    doc = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        context = None
        last_error = None
        for _ in range(100):
            try:
                context = resolver.resolve("uno:pipe,name=" + connection + ";urp;StarOffice.ComponentContext")
                break
            except Exception as error:
                last_error = error
                time.sleep(0.1)
        if context is None:
            raise RuntimeError("LibreOffice UNO connection timed out: " + str(last_error))
        desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        doc = desktop.loadComponentFromURL(url(job["input"]), "_blank", 0, (
            prop("Hidden", True), prop("ReadOnly", job["mode"] == "read"),
            prop("MacroExecutionMode", 4), prop("UpdateDocMode", 0),
        ))
        if doc is None:
            raise RuntimeError("LibreOffice could not open the document")
        before = inspect_doc(doc, extension)
        pdf_filter = {"docx": "writer_pdf_Export", "xlsx": "calc_pdf_Export", "pptx": "impress_pdf_Export"}[extension]
        if job.get("beforePreview"):
            doc.storeToURL(url(job["beforePreview"]), (prop("FilterName", pdf_filter), prop("Overwrite", False)))
        if job["mode"] == "edit":
            edit_doc(doc, extension, job["edits"])
            filters = {"docx": "Office Open XML Text", "xlsx": "Calc MS Excel 2007 XML", "pptx": "Impress MS PowerPoint 2007 XML"}
            doc.storeAsURL(url(job["output"]), (prop("FilterName", filters[extension]), prop("Overwrite", False)))
        if job.get("preview"):
            doc.storeToURL(url(job["preview"]), (prop("FilterName", pdf_filter), prop("Overwrite", False)))
        return {"before": before, "after": inspect_doc(doc, extension) if job["mode"] == "edit" else None,
                "unsupported": blocked}
    finally:
        if doc is not None:
            try:
                doc.close(True)
            except Exception:
                doc.dispose()


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": run(json.load(sys.stdin))}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
