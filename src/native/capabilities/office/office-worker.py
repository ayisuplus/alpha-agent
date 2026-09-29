"""Run one LibreOffice document job with the Python/UNO shipped by LibreOffice.

Jobs (JSON on stdin, JSON on stdout):
  inspect      -> {doc, unsupported}   paragraphs/tables/sheets/slides with editable addresses
  edit         -> {doc, unsupported}   apply alpha_office edit ops to a staged copy, save output
  create_pptx  -> {slides}             build an Impress deck from an outline, save as pptx

The runtime always works on a staged copy in a temp directory; the caller never
passes the original document as the output target.
"""

import json
import pathlib
import sys
import time
import zipfile

import uno
from com.sun.star.beans import PropertyValue

PDF_FILTERS = {"docx": "writer_pdf_Export", "xlsx": "calc_pdf_Export", "pptx": "impress_pdf_Export"}
SAVE_FILTERS = {
    "docx": "Office Open XML Text",
    "xlsx": "Calc MS Excel 2007 XML",
    "pptx": "Impress MS PowerPoint 2007 XML",
}
SLIDE_LAYOUTS = {"title": 0, "title_content": 1, "blank": 20}


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


def column_name(index):
    name = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def column_index(name):
    index = 0
    for char in name:
        if not ("A" <= char <= "Z"):
            raise ValueError("Invalid cell address: " + name)
        index = index * 26 + (ord(char) - 64)
    return index - 1


def cell_address(column, row):
    return column_name(column) + str(row + 1)


def parse_range(text):
    head, _, tail = str(text).upper().partition(":")
    if not tail:
        tail = head
    result = []
    for part in (head, tail):
        letters = "".join(c for c in part if c.isalpha())
        digits = "".join(c for c in part if c.isdigit())
        if not letters or not digits:
            raise ValueError("Invalid range: " + str(text))
        result.append((column_index(letters), int(digits) - 1))
    (start_column, start_row), (end_column, end_row) = result
    if start_column > end_column or start_row > end_row:
        raise ValueError("Invalid range: " + str(text))
    return start_column, start_row, end_column, end_row


def inspect_doc(doc, extension):
    if extension == "docx":
        paragraphs = []
        for index, item in enumerate(word_paragraphs(doc)):
            try:
                style = item.ParaStyleName
            except Exception:
                style = None
            paragraphs.append({"index": index, "style": style, "text": item.String})
        tables = []
        for table in doc.TextTables:
            rows = table.Rows.getCount()
            cols = len(table.CellNames) // rows if rows else 0
            tables.append({"name": table.Name, "rows": rows, "cols": cols})
        return {"paragraphs": paragraphs, "tables": tables}
    if extension == "xlsx":
        sheets = []
        for sheet in doc.Sheets:
            cursor = sheet.createCursor()
            cursor.gotoEndOfUsedArea(True)
            address = cursor.RangeAddress
            used = cell_address(0, 0) + ":" + cell_address(address.EndColumn, address.EndRow)
            sheets.append({"name": sheet.Name, "usedRange": used})
        return {"sheets": sheets}
    slides = []
    for page_index in range(doc.DrawPages.Count):
        page = doc.DrawPages.getByIndex(page_index)
        shapes = []
        title = ""
        for shape_index in range(page.Count):
            shape = page.getByIndex(shape_index)
            text = shape.String if hasattr(shape, "String") else ""
            shape_type = shape.ShapeType.split(".")[-1]
            shapes.append({"index": shape_index, "type": shape_type, "text": text})
            if not title and "TitleText" in shape_type:
                title = text
        slides.append({"index": page_index, "title": title, "shapes": shapes})
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


def require_index(value, count, label):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value >= count:
        raise ValueError("Invalid " + label + " index: " + str(value))
    return value


def op_replace_text(doc, extension, op):
    if extension != "docx":
        raise ValueError("replace_text only applies to docx documents")
    paragraph_index = require_index(op.get("paragraph"), len(word_paragraphs(doc)), "paragraph")
    expected = op.get("expected")
    replacement = op.get("replacement")
    if not isinstance(expected, str) or not expected:
        raise ValueError("replace_text requires a non-empty expected value")
    if not isinstance(replacement, str):
        raise ValueError("replace_text requires a string replacement")
    paragraph = word_paragraphs(doc)[paragraph_index]
    replace_text(doc.Text, expected, replacement, paragraph)


def op_insert_paragraph(doc, extension, op):
    if extension != "docx":
        raise ValueError("insert_paragraph only applies to docx documents")
    after = require_index(op.get("after"), len(word_paragraphs(doc)), "paragraph")
    text = op.get("text")
    if not isinstance(text, str):
        raise ValueError("insert_paragraph requires text")
    style = op.get("style")
    if style is not None and not isinstance(style, str):
        raise ValueError("insert_paragraph style must be a string")
    paragraph = word_paragraphs(doc)[after]
    cursor = doc.Text.createTextCursorByRange(paragraph.getEnd())
    doc.Text.insertControlCharacter(
        cursor, uno.getConstantByName("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK"), False)
    doc.Text.insertString(cursor, text, False)
    if style:
        cursor.ParaStyleName = style
        applied = cursor.ParaStyleName
        if (applied or "").lower() != style.lower():
            raise ValueError("Unknown paragraph style: " + style)


def op_add_table_row(doc, extension, op):
    if extension != "docx":
        raise ValueError("add_table_row only applies to docx documents")
    name = op.get("table")
    cells = op.get("cells")
    if not isinstance(name, str) or not isinstance(cells, list):
        raise ValueError("add_table_row requires table and cells")
    if not doc.TextTables.hasByName(name):
        raise ValueError("Unknown table: " + name)
    table = doc.TextTables.getByName(name)
    rows = table.Rows.getCount()
    cols = len(table.CellNames) // rows if rows else 0
    if len(cells) > cols:
        raise ValueError("cells exceeds the table column count")
    cursor = table.getCellByName(cell_address(0, rows - 1)).Text.createTextCursor()
    doc.getCurrentController().select(cursor)
    DISPATCHER.executeDispatch(doc.getCurrentController().getFrame(), ".uno:InsertRows", "", 0, ())
    if table.Rows.getCount() != rows + 1:
        raise ValueError("Inserting the table row failed")
    for index, value in enumerate(cells):
        table.getCellByName(cell_address(index, rows)).String = "" if value is None else str(value)


def op_set_cells(doc, extension, op):
    if extension != "xlsx":
        raise ValueError("set_cells only applies to xlsx documents")
    sheet_name = op.get("sheet")
    if not doc.Sheets.hasByName(sheet_name if isinstance(sheet_name, str) else ""):
        raise ValueError("Unknown sheet: " + str(sheet_name))
    sheet = doc.Sheets.getByName(sheet_name)
    values = op.get("values")
    if not isinstance(values, list) or not values:
        raise ValueError("set_cells requires values")
    start_column, start_row, end_column, end_row = parse_range(op.get("range"))
    rows = end_row - start_row + 1
    cols = end_column - start_column + 1
    if len(values) != rows:
        raise ValueError("values row count does not match the range")
    for row_offset, row in enumerate(values):
        if not isinstance(row, list) or len(row) != cols:
            raise ValueError("values column count does not match the range")
        for column_offset, value in enumerate(row):
            if value is None:
                continue
            cell = sheet.getCellByPosition(start_column + column_offset, start_row + row_offset)
            if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                raise ValueError("Unsupported cell value: " + repr(value))
            if isinstance(value, (int, float)):
                cell.Value = float(value)
            elif value.startswith("="):
                cell.Formula = value
            else:
                cell.String = value


def op_add_slide(doc, extension, op):
    if extension != "pptx":
        raise ValueError("add_slide only applies to pptx documents")
    after = require_index(op.get("after"), doc.DrawPages.Count, "slide")
    title = op.get("title")
    bullets = op.get("bullets")
    if not isinstance(title, str) or not isinstance(bullets, list):
        raise ValueError("add_slide requires title and bullets")
    if any(not isinstance(item, str) for item in bullets):
        raise ValueError("add_slide bullets must be strings")
    layout_name = op.get("layout") or "title_content"
    if layout_name not in SLIDE_LAYOUTS:
        raise ValueError("Unknown slide layout: " + str(layout_name))
    page = doc.DrawPages.insertNewByIndex(after + 1)
    fill_slide(doc, page, title, bullets, SLIDE_LAYOUTS[layout_name])


def fill_slide(doc, page, title, bullets, layout_id):
    body = "\n".join(bullets)
    if layout_id == 20:
        if title:
            shape = text_shape(doc, (2200, 800, 23600, 3200))
            page.add(shape)
            shape.String = title
        if body:
            shape = text_shape(doc, (2200, 4800, 23600, 11500))
            page.add(shape)
            shape.String = body
        return
    page.Layout = layout_id
    if page.Count < 1:
        raise ValueError("LibreOffice created no placeholder for this layout")
    page.getByIndex(0).String = title
    if body:
        if page.Count < 2:
            raise ValueError("LibreOffice created no body placeholder for this layout")
        page.getByIndex(1).String = body


def text_shape(doc, box):
    shape = doc.createInstance("com.sun.star.drawing.TextShape")
    point = uno.createUnoStruct("com.sun.star.awt.Point")
    size = uno.createUnoStruct("com.sun.star.awt.Size")
    point.X, point.Y, size.Width, size.Height = box
    shape.Position = point
    shape.Size = size
    return shape


def op_remove_slide(doc, extension, op):
    if extension != "pptx":
        raise ValueError("remove_slide only applies to pptx documents")
    index = require_index(op.get("index"), doc.DrawPages.Count, "slide")
    if doc.DrawPages.Count <= 1:
        raise ValueError("A presentation must keep at least one slide")
    doc.DrawPages.remove(doc.DrawPages.getByIndex(index))


def op_duplicate_slide(doc, extension, op):
    if extension != "pptx":
        raise ValueError("duplicate_slide only applies to pptx documents")
    index = require_index(op.get("index"), doc.DrawPages.Count, "slide")
    after = require_index(op.get("after"), doc.DrawPages.Count, "slide")
    source = doc.DrawPages.getByIndex(index)
    if after == index:
        doc.duplicate(source)
        return
    duplicate = doc.duplicate(source)
    target = doc.DrawPages.insertNewByIndex(after + 1 if after < index else after + 2)
    target.setMasterPage(source.getMasterPage())
    while duplicate.Count > 0:
        shape = duplicate.getByIndex(0)
        duplicate.remove(shape)
        target.add(shape)
    doc.DrawPages.remove(duplicate)


def op_set_shape(doc, extension, op):
    if extension != "pptx":
        raise ValueError("set_shape only applies to pptx documents")
    slide = require_index(op.get("slide"), doc.DrawPages.Count, "slide")
    page = doc.DrawPages.getByIndex(slide)
    shape_index = require_index(op.get("shape"), page.Count, "shape")
    shape = page.getByIndex(shape_index)
    text = op.get("text")
    image = op.get("image")
    if text is None and image is None:
        raise ValueError("set_shape requires text or image")
    if text is not None:
        if not isinstance(text, str) or not hasattr(shape, "String"):
            raise ValueError("This shape does not support text")
        shape.String = text
    if image is not None:
        if not shape.getPropertySetInfo().hasPropertyByName("GraphicURL"):
            raise ValueError("This shape does not support images")
        shape.GraphicURL = url(image)


OPERATIONS = {
    "replace_text": op_replace_text,
    "insert_paragraph": op_insert_paragraph,
    "add_table_row": op_add_table_row,
    "set_cells": op_set_cells,
    "add_slide": op_add_slide,
    "remove_slide": op_remove_slide,
    "duplicate_slide": op_duplicate_slide,
    "set_shape": op_set_shape,
}


def edit_doc(doc, extension, ops):
    if not isinstance(ops, list) or not ops or len(ops) > 100:
        raise ValueError("Provide 1-100 edit operations")
    for index, op in enumerate(ops):
        if not isinstance(op, dict):
            raise ValueError("Each edit operation must be an object")
        name = op.get("op")
        handler = OPERATIONS.get(name)
        if handler is None:
            raise ValueError("Unknown edit operation: " + str(name))
        try:
            handler(doc, extension, op)
        except ValueError as error:
            raise ValueError("edit op %d (%s): %s" % (index, name, error)) from error
    if extension == "xlsx":
        doc.calculateAll()


def create_pptx(output, slides):
    if not isinstance(slides, list) or not slides or len(slides) > 100:
        raise ValueError("Provide 1-100 slides")
    doc = open_document("private:factory/simpress", read_only=False)
    try:
        for index, slide in enumerate(slides):
            if not isinstance(slide, dict):
                raise ValueError("Each slide must be an object")
            title = slide.get("title")
            bullets = slide.get("bullets")
            if not isinstance(title, str) or not isinstance(bullets, list):
                raise ValueError("Each slide requires title and bullets")
            if any(not isinstance(item, str) for item in bullets):
                raise ValueError("Slide bullets must be strings")
            layout_name = slide.get("layout") or ("title" if not bullets else "title_content")
            if layout_name not in SLIDE_LAYOUTS:
                raise ValueError("Unknown slide layout: " + str(layout_name))
            page = doc.DrawPages.getByIndex(0) if index == 0 else doc.DrawPages.insertNewByIndex(index)
            fill_slide(doc, page, title, bullets, SLIDE_LAYOUTS[layout_name])
        doc.storeToURL(url(output), (prop("FilterName", SAVE_FILTERS["pptx"]), prop("Overwrite", False)))
    finally:
        close(doc)
    return {"slides": len(slides)}


def open_document(source, read_only):
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    context = None
    last_error = None
    for _ in range(200):
        try:
            context = resolver.resolve("uno:pipe,name=" + CONNECTION + ";urp;StarOffice.ComponentContext")
            break
        except Exception as error:
            last_error = error
            time.sleep(0.1)
    if context is None:
        raise RuntimeError("LibreOffice UNO connection timed out: " + str(last_error))
    global DESKTOP, DISPATCHER
    if DESKTOP is None:
        DESKTOP = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        DISPATCHER = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.DispatchHelper", context)
    doc = DESKTOP.loadComponentFromURL(url(source) if not source.startswith("private:") else source, "_blank", 0, (
        prop("Hidden", True), prop("ReadOnly", read_only),
        prop("MacroExecutionMode", 4), prop("UpdateDocMode", 0),
    ))
    if doc is None:
        raise RuntimeError("LibreOffice could not open the document")
    return doc


def close(doc):
    if doc is not None:
        try:
            doc.close(True)
        except Exception:
            doc.dispose()


def run(job):
    kind = job["job"]
    if kind == "create_pptx":
        return create_pptx(job["output"], job["slides"])
    extension = job["format"]
    blocked = check_features(job["input"], extension)
    if blocked and kind == "edit":
        raise ValueError("Editing paused for unsupported features: " + ", ".join(blocked))
    doc = open_document(job["input"], read_only=(kind == "inspect"))
    try:
        if kind == "inspect":
            return {"doc": inspect_doc(doc, extension), "unsupported": blocked}
        before = inspect_doc(doc, extension)
        if job.get("beforePreview"):
            doc.storeToURL(url(job["beforePreview"]), (prop("FilterName", PDF_FILTERS[extension]), prop("Overwrite", False)))
        edit_doc(doc, extension, job["ops"])
        doc.storeAsURL(url(job["output"]), (prop("FilterName", SAVE_FILTERS[extension]), prop("Overwrite", False)))
        if job.get("preview"):
            doc.storeToURL(url(job["preview"]), (prop("FilterName", PDF_FILTERS[extension]), prop("Overwrite", False)))
        return {"doc": inspect_doc(doc, extension), "before": before, "unsupported": blocked}
    finally:
        close(doc)


CONNECTION = None
DESKTOP = None
DISPATCHER = None


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        CONNECTION = payload.get("connection")
        print(json.dumps({"ok": True, "result": run(payload)}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
