#!/usr/bin/env python3
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
import subprocess
import sys
from tempfile import NamedTemporaryFile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import xml.etree.ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"
XML_NS = "http://www.w3.org/XML/1998/namespace"
ET.register_namespace("w", W_NS)


def _w(local_name: str) -> str:
    return f"{W}{local_name}"


def _w_attr(attr_name: str) -> str:
    return f"{W}{attr_name}"


def _session_id() -> str:
    state_payload = _load_json_file(_session_state_path())
    if isinstance(state_payload, dict):
        state_value = state_payload.get("session_id")
        if isinstance(state_value, str) and state_value.strip():
            return state_value.strip()

    value = os.environ.get("PI_DOCX_SESSION_ID", "").strip()
    if not value:
        raise SystemExit("PI_DOCX_SESSION_ID is not set")
    return value


def _workspace_dir() -> Path:
    value = os.environ.get("PI_DOCX_WORKSPACE_DIR", "").strip()
    if not value:
        return Path.cwd()
    return Path(value)


def _working_docx_path() -> Path:
    value = os.environ.get("PI_DOCX_WORKING_DOCX_PATH", "").strip()
    if value:
        return Path(value)
    return _workspace_dir() / "working.docx"


def _session_state_path() -> Path:
    value = os.environ.get("PI_DOCX_SESSION_STATE_PATH", "").strip()
    if value:
        return Path(value)
    return _workspace_dir() / "headless_word_session.json"


def _manifest_path() -> Path:
    return _workspace_dir() / "workspace_manifest.json"


def _path_env() -> str:
    home_bin = Path.home() / ".local" / "bin"
    return f"{home_bin}:{os.environ.get('PATH', '')}"


def _run_headless_word(*args: str, input_text: str | None = None) -> str:
    result = subprocess.run(
        ["headless-word", *args],
        input=input_text,
        capture_output=True,
        text=True,
        env={**os.environ, "PATH": _path_env()},
        check=False,
    )
    if result.returncode != 0:
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        parts = [f"headless-word {' '.join(args)} failed"]
        if stdout:
            parts.append(f"STDOUT:\n{stdout}")
        if stderr:
            parts.append(f"STDERR:\n{stderr}")
        raise SystemExit("\n\n".join(parts))
    return result.stdout


def _run_headless_word_json(*args: str, input_text: str | None = None):
    output = _run_headless_word(*args, input_text=input_text)
    return json.loads(output)


def _print_json(value) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _load_json_file(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _update_manifest_session_id(session_id: str) -> None:
    manifest_path = _manifest_path()
    manifest = _load_json_file(manifest_path)
    if not isinstance(manifest, dict):
        return
    manifest["sessionId"] = session_id
    _write_json(manifest_path, manifest)


def _write_session_state(session_id: str) -> None:
    _write_json(_session_state_path(), {"session_id": session_id})
    _update_manifest_session_id(session_id)


def _run_headless_word_allow_failure(*args: str, input_text: str | None = None):
    return subprocess.run(
        ["headless-word", *args],
        input=input_text,
        capture_output=True,
        text=True,
        env={**os.environ, "PATH": _path_env()},
        check=False,
    )


def _save_current_session() -> None:
    _run_headless_word_json("save", _session_id())


def _enable_tracked_changes_for_session(session_id: str) -> None:
    payload = _run_headless_word_json(
        "execute",
        session_id,
        input_text=f"{_mutating_preamble()}\nresult = {{'session_id': {session_id!r}}}\n",
    )
    if not payload.get("success", False):
        raise SystemExit(f"Failed to enable tracked changes for session {session_id}")


def _reopen_working_document() -> dict[str, str]:
    previous_session_id = _session_id()
    _run_headless_word_allow_failure("close", previous_session_id)
    payload = _run_headless_word_json("open", str(_working_docx_path()))
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        raise SystemExit("headless-word open did not return a session_id")
    _enable_tracked_changes_for_session(session_id)
    _write_session_state(session_id)
    return {
        "previous_session_id": previous_session_id,
        "session_id": session_id,
        "path": str(_working_docx_path()),
    }


def _is_story_member(name: str) -> bool:
    return name == "word/document.xml" or name.startswith("word/header") or name.startswith("word/footer") or name in {
        "word/footnotes.xml",
        "word/endnotes.xml",
    }


def _extract_run_text(run: ET.Element) -> str:
    parts: list[str] = []
    for child in list(run):
        if child.tag == _w("t"):
            parts.append(child.text or "")
        elif child.tag == _w("tab"):
            parts.append("\t")
        elif child.tag in {_w("br"), _w("cr")}:
            parts.append("\n")
    return "".join(parts)


def _append_text_to_run(run: ET.Element, text: str) -> None:
    buffer = ""
    for char in text:
        if char not in {"\n", "\t"}:
            buffer += char
            continue
        if buffer:
            text_node = ET.Element(_w("t"))
            if buffer.startswith(" ") or buffer.endswith(" "):
                text_node.set(f"{{{XML_NS}}}space", "preserve")
            text_node.text = buffer
            run.append(text_node)
            buffer = ""
        if char == "\n":
            run.append(ET.Element(_w("br")))
        else:
            run.append(ET.Element(_w("tab")))
    if buffer or not text:
        text_node = ET.Element(_w("t"))
        if buffer.startswith(" ") or buffer.endswith(" "):
            text_node.set(f"{{{XML_NS}}}space", "preserve")
        text_node.text = buffer
        run.append(text_node)


def _clone_text_run(template_run: ET.Element, text: str) -> ET.Element:
    run = deepcopy(template_run)
    for child in list(run):
        if child.tag != _w("rPr"):
            run.remove(child)
    _append_text_to_run(run, text)
    return run


def _replace_field_sequence(paragraph: ET.Element, occurrence: dict[str, object], text: str) -> None:
    start_idx = int(occurrence["start_idx"])
    end_idx = int(occurrence["end_idx"])
    children = list(paragraph)
    template_run = occurrence["template_run"]
    if not isinstance(template_run, ET.Element):
        raise SystemExit("Internal error: missing template run")
    replacement_run = _clone_text_run(template_run, text)
    for index in range(end_idx, start_idx - 1, -1):
        paragraph.remove(children[index])
    paragraph.insert(start_idx, replacement_run)


def _collect_paragraph_field_occurrences(
    paragraph: ET.Element,
    *,
    story: str,
    paragraph_index: int,
    table_index: int | None,
    row_index: int | None,
    cell_index: int | None,
) -> list[dict[str, object]]:
    children = list(paragraph)
    occurrences: list[dict[str, object]] = []
    index = 0
    while index < len(children):
        child = children[index]
        if child.tag != _w("r"):
            index += 1
            continue
        field_char = child.find(_w("fldChar"))
        if field_char is None or field_char.get(_w_attr("fldCharType")) != "begin":
            index += 1
            continue
        ff_data = field_char.find(_w("ffData"))
        if ff_data is None:
            index += 1
            continue
        name_element = ff_data.find(_w("name"))
        if name_element is None:
            index += 1
            continue
        field_name = name_element.get(_w_attr("val"))
        if not field_name:
            index += 1
            continue
        default_element = ff_data.find(f".//{_w('default')}")
        default_text = default_element.get(_w_attr("val")) if default_element is not None else ""
        separate_idx: int | None = None
        end_idx: int | None = None
        displayed_parts: list[str] = []
        template_run: ET.Element | None = None
        inner_idx = index + 1
        while inner_idx < len(children):
            inner_child = children[inner_idx]
            if inner_child.tag == _w("r"):
                inner_field_char = inner_child.find(_w("fldChar"))
                if inner_field_char is not None:
                    field_type = inner_field_char.get(_w_attr("fldCharType"))
                    if field_type == "separate":
                        separate_idx = inner_idx
                        inner_idx += 1
                        continue
                    if field_type == "end":
                        end_idx = inner_idx
                        break
                if separate_idx is not None:
                    if template_run is None and (
                        inner_child.find(_w("rPr")) is not None or _extract_run_text(inner_child)
                    ):
                        template_run = inner_child
                    displayed_parts.append(_extract_run_text(inner_child))
            inner_idx += 1
        if end_idx is None:
            index += 1
            continue
        if template_run is None:
            template_run = child
        occurrences.append(
            {
                "story": story,
                "name": field_name,
                "default_text": default_text,
                "current_text": "".join(displayed_parts),
                "paragraph_index": paragraph_index,
                "table_index": table_index,
                "row_index": row_index,
                "cell_index": cell_index,
                "paragraph": paragraph,
                "start_idx": index,
                "end_idx": end_idx,
                "template_run": template_run,
            }
        )
        index = end_idx + 1
    return occurrences


def _collect_story_field_occurrences(root: ET.Element, story: str) -> list[dict[str, object]]:
    body = root.find(_w("body")) if story == "word/document.xml" else root
    if body is None:
        return []
    occurrences: list[dict[str, object]] = []
    paragraph_index = 0
    table_counter = 0

    def walk_children(node: ET.Element, table_context: tuple[int, int, int] | None = None) -> None:
        nonlocal paragraph_index, table_counter
        for child in list(node):
            if child.tag == _w("p"):
                table_index = row_index = cell_index = None
                if table_context is not None:
                    table_index, row_index, cell_index = table_context
                occurrences.extend(
                    _collect_paragraph_field_occurrences(
                        child,
                        story=story,
                        paragraph_index=paragraph_index,
                        table_index=table_index,
                        row_index=row_index,
                        cell_index=cell_index,
                    )
                )
                paragraph_index += 1
                continue
            if child.tag != _w("tbl"):
                continue
            current_table_index = table_counter
            table_counter += 1
            rows = [row for row in list(child) if row.tag == _w("tr")]
            for row_index, row in enumerate(rows):
                cells = [cell for cell in list(row) if cell.tag == _w("tc")]
                for cell_index, cell in enumerate(cells):
                    walk_children(cell, (current_table_index, row_index, cell_index))

    walk_children(body)
    return occurrences


def _read_docx_form_fields(docx_path: Path) -> tuple[list[dict[str, object]], dict[str, ET.Element]]:
    fields: list[dict[str, object]] = []
    xml_roots: dict[str, ET.Element] = {}
    with ZipFile(docx_path) as archive:
        for member_name in archive.namelist():
            if not _is_story_member(member_name):
                continue
            root = ET.fromstring(archive.read(member_name))
            xml_roots[member_name] = root
            fields.extend(_collect_story_field_occurrences(root, member_name))
    return fields, xml_roots


def _write_docx_roots(docx_path: Path, xml_roots: dict[str, ET.Element]) -> None:
    with NamedTemporaryFile(delete=False, suffix=".docx", dir=str(docx_path.parent)) as temp_file:
        temp_path = Path(temp_file.name)
    try:
        with ZipFile(docx_path) as source_archive, ZipFile(temp_path, "w", compression=ZIP_DEFLATED) as output_archive:
            for info in source_archive.infolist():
                if info.filename in xml_roots:
                    xml_bytes = ET.tostring(
                        xml_roots[info.filename],
                        encoding="utf-8",
                        xml_declaration=True,
                    )
                    output_archive.writestr(info, xml_bytes)
                else:
                    output_archive.writestr(info, source_archive.read(info.filename))
        temp_path.replace(docx_path)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def _ensure_field_targets(
    fields: list[dict[str, object]],
    *,
    name: str | None = None,
    default_text: str | None = None,
) -> list[dict[str, object]]:
    matches = []
    for field in fields:
        if name is not None and field["name"] == name:
            matches.append(field)
        elif default_text is not None and field["default_text"] == default_text:
            matches.append(field)
    if not matches:
        target = f"name={name!r}" if name is not None else f"default_text={default_text!r}"
        raise SystemExit(f"No form fields matched {target}")
    return matches


def _mutating_preamble() -> str:
    return "\n".join(
        [
            "doc.setPropertyValue('RecordChanges', True)",
            "doc.setPropertyValue('ShowChanges', True)",
        ]
    )


def _execute_python(code: str):
    sid = _session_id()
    final_code = f"{_mutating_preamble()}\n{code}\n"
    return _run_headless_word_json("execute", sid, input_text=final_code)


def _cmd_info(_args: argparse.Namespace) -> None:
    _print_json(
        {
            "session_id": _session_id(),
            "workspace_dir": str(_workspace_dir()),
            "helper": "./docx-tool",
        }
    )


def _cmd_text(args: argparse.Namespace) -> None:
    payload = _run_headless_word_json("get-document-text", _session_id())
    if args.out:
        _write_json(Path(args.out), payload)
    _print_json(payload)


def _cmd_structure(args: argparse.Namespace) -> None:
    payload = _run_headless_word_json("get-document-structure", _session_id())
    if args.out:
        _write_json(Path(args.out), payload)
    _print_json(payload)


def _cmd_refresh(args: argparse.Namespace) -> None:
    workspace_dir = _workspace_dir()
    text_path = Path(args.text_out) if args.text_out else workspace_dir / "document_text.current.json"
    structure_path = (
        Path(args.structure_out)
        if args.structure_out
        else workspace_dir / "document_structure.current.json"
    )
    text_payload = _run_headless_word_json("get-document-text", _session_id())
    structure_payload = _run_headless_word_json("get-document-structure", _session_id())
    _write_json(text_path, text_payload)
    _write_json(structure_path, structure_payload)
    _print_json({"text": str(text_path), "structure": str(structure_path)})


def _cmd_save(args: argparse.Namespace) -> None:
    sid = _session_id()
    if args.path:
        payload = _run_headless_word_json("save", sid, "--path", args.path)
    else:
        payload = _run_headless_word_json("save", sid)
    _print_json(payload)


def _cmd_export_pdf(args: argparse.Namespace) -> None:
    sid = _session_id()
    argv = ["export-pdf", sid, args.path]
    if args.no_comments:
        argv.append("--no-comments")
    if args.no_changes:
        argv.append("--no-changes")
    payload = _run_headless_word_json(*argv)
    _print_json(payload)


def _cmd_screenshot(args: argparse.Namespace) -> None:
    sid = _session_id()
    argv = [
        "screenshot",
        sid,
        "--page",
        str(args.page),
        "--out",
        args.out,
    ]
    if args.no_comments:
        argv.append("--no-comments")
    if args.no_changes:
        argv.append("--no-changes")
    payload = _run_headless_word_json(*argv)
    _print_json(payload)


def _cmd_get_ooxml(args: argparse.Namespace) -> None:
    sid = _session_id()
    argv = ["get-ooxml", sid]
    if args.start_child is not None:
        argv.extend(["--start-child", str(args.start_child)])
    if args.end_child is not None:
        argv.extend(["--end-child", str(args.end_child)])
    payload = _run_headless_word_json(*argv)
    if args.out:
        _write_json(Path(args.out), payload)
    _print_json(payload)


def _cmd_insert_ooxml(args: argparse.Namespace) -> None:
    sid = _session_id()
    argv = ["insert-ooxml", sid]
    if args.xml is not None:
        argv.extend(["--xml", args.xml])
    else:
        argv.extend(["--file", args.file])
    if args.position is not None:
        argv.extend(["--position", args.position])
    payload = _run_headless_word_json(*argv)
    _print_json(payload)


def _cmd_find_text(args: argparse.Namespace) -> None:
    code = f"""
needle = {args.text!r}
match_mode = {args.match!r}
paragraphs = []
enum = text.createEnumeration()
paragraph_index = 0
while enum.hasMoreElements():
    paragraph = enum.nextElement()
    paragraph_text = paragraph.getString()
    matched = (
        paragraph_text == needle if match_mode == "exact" else needle in paragraph_text
    )
    if matched:
        paragraphs.append(
            {{
                "paragraph_index": paragraph_index,
                "text": paragraph_text,
            }}
        )
    paragraph_index += 1
result = {{
    "action": "find-text",
    "text": needle,
    "match": match_mode,
    "count": len(paragraphs),
    "paragraphs": paragraphs,
}}
"""
    _print_json(_execute_python(code))


def _cmd_replace_text(args: argparse.Namespace) -> None:
    code = f"""
search = doc.createSearchDescriptor()
search.SearchCaseSensitive = True
search.SearchString = {args.old!r}
found = doc.findAll(search)
count = found.getCount()
if count == 0:
    raise RuntimeError("Text not found for replacement")
if count > 1:
    raise RuntimeError(f"Ambiguous replacement target: found {{count}} matches for exact text")
found.getByIndex(0).setString({args.new!r})
result = {{
    "action": "replace-text",
    "old": {args.old!r},
    "new": {args.new!r},
    "match_count": count,
}}
"""
    _print_json(_execute_python(code))


def _cmd_replace_all_text(args: argparse.Namespace) -> None:
    code = f"""
search = doc.createSearchDescriptor()
search.SearchCaseSensitive = True
search.SearchString = {args.old!r}
found = doc.findAll(search)
count = found.getCount()
if count == 0:
    raise RuntimeError("Text not found for replacement")
for index in range(count):
    found.getByIndex(index).setString({args.new!r})
result = {{
    "action": "replace-all-text",
    "old": {args.old!r},
    "new": {args.new!r},
    "match_count": count,
}}
"""
    _print_json(_execute_python(code))


def _cmd_delete_text(args: argparse.Namespace) -> None:
    code = f"""
search = doc.createSearchDescriptor()
search.SearchCaseSensitive = True
search.SearchString = {args.text!r}
found = doc.findAll(search)
count = found.getCount()
if count == 0:
    raise RuntimeError("Text not found for deletion")
if count > 1:
    raise RuntimeError(f"Ambiguous deletion target: found {{count}} matches for exact text")
found.getByIndex(0).setString("")
result = {{
    "action": "delete-text",
    "text": {args.text!r},
    "match_count": count,
}}
"""
    _print_json(_execute_python(code))


def _cmd_delete_all_text(args: argparse.Namespace) -> None:
    code = f"""
search = doc.createSearchDescriptor()
search.SearchCaseSensitive = True
search.SearchString = {args.text!r}
found = doc.findAll(search)
count = found.getCount()
if count == 0:
    raise RuntimeError("Text not found for deletion")
for index in range(count):
    found.getByIndex(index).setString("")
result = {{
    "action": "delete-all-text",
    "text": {args.text!r},
    "match_count": count,
}}
"""
    _print_json(_execute_python(code))


def _cmd_append_paragraph(args: argparse.Namespace) -> None:
    style_snippet = (
        f'cursor.setPropertyValue("ParaStyleName", {args.style!r})'
        if args.style
        else ""
    )
    code = f"""
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK

cursor = text.createTextCursor()
cursor.gotoEnd(False)
if text.getString():
    text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
{style_snippet}
text.insertString(cursor, {args.text!r}, False)
result = {{ "action": "append-paragraph", "text": {args.text!r}, "style": {args.style!r} }}
"""
    _print_json(_execute_python(code))


def _cmd_accept_all_changes(_args: argparse.Namespace) -> None:
    code = """
ctx = uno.getComponentContext()
smgr = ctx.ServiceManager
helper = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
frame = doc.getCurrentController().getFrame()
helper.executeDispatch(frame, ".uno:AcceptAllTrackedChanges", "", 0, tuple())
result = {"action": "accept-all-changes"}
"""
    _print_json(_execute_python(code))


def _cmd_reject_all_changes(_args: argparse.Namespace) -> None:
    code = """
ctx = uno.getComponentContext()
smgr = ctx.ServiceManager
helper = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
frame = doc.getCurrentController().getFrame()
helper.executeDispatch(frame, ".uno:RejectAllTrackedChanges", "", 0, tuple())
result = {"action": "reject-all-changes"}
"""
    _print_json(_execute_python(code))


def _cmd_insert_after(args: argparse.Namespace) -> None:
    style_snippet = (
        f'cursor.setPropertyValue("ParaStyleName", {args.style!r})'
        if args.style
        else ""
    )
    code = f"""
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK

matches = []
enum = text.createEnumeration()
paragraph_index = 0
while enum.hasMoreElements():
    paragraph = enum.nextElement()
    if paragraph.getString() == {args.anchor!r}:
        matches.append((paragraph_index, paragraph))
    paragraph_index += 1
if not matches:
    raise RuntimeError("Anchor paragraph not found")
if len(matches) > 1:
    raise RuntimeError(f"Ambiguous anchor paragraph: found {{len(matches)}} exact matches")
matched_index, target = matches[0]
cursor = text.createTextCursor()
cursor.gotoRange(target.getEnd(), False)
text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
{style_snippet}
text.insertString(cursor, {args.text!r}, False)
result = {{
    "action": "insert-after",
    "anchor": {args.anchor!r},
    "text": {args.text!r},
    "style": {args.style!r},
    "anchor_paragraph_index": matched_index,
    "match_count": len(matches),
}}
    """
    _print_json(_execute_python(code))


def _serialize_field_occurrence(field: dict[str, object]) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": field["name"],
        "default_text": field["default_text"],
        "current_text": field["current_text"],
        "story": field["story"],
        "paragraph_index": field["paragraph_index"],
    }
    if field["table_index"] is not None:
        payload["table_index"] = field["table_index"]
    if field["row_index"] is not None:
        payload["row_index"] = field["row_index"]
    if field["cell_index"] is not None:
        payload["cell_index"] = field["cell_index"]
    return payload


def _apply_field_updates(updates: list[tuple[dict[str, object], str]]) -> None:
    grouped: dict[int, dict[str, object]] = {}
    for occurrence, replacement_text in updates:
        paragraph = occurrence["paragraph"]
        if not isinstance(paragraph, ET.Element):
            raise SystemExit("Internal error: missing paragraph for field update")
        bucket = grouped.setdefault(
            id(paragraph),
            {
                "paragraph": paragraph,
                "updates": [],
            },
        )
        bucket["updates"].append((occurrence, replacement_text))
    for bucket in grouped.values():
        paragraph = bucket["paragraph"]
        updates_in_paragraph = bucket["updates"]
        for occurrence, replacement_text in sorted(
            updates_in_paragraph,
            key=lambda item: int(item[0]["start_idx"]),
            reverse=True,
        ):
            _replace_field_sequence(paragraph, occurrence, replacement_text)


def _load_mapping(path: str) -> dict[str, str]:
    payload = _load_json_file(Path(path))
    if not isinstance(payload, dict):
        raise SystemExit("Mapping file must contain a JSON object")
    mapping: dict[str, str] = {}
    for key, value in payload.items():
        if not isinstance(key, str) or not key.strip():
            raise SystemExit("Mapping keys must be non-empty strings")
        if not isinstance(value, str):
            raise SystemExit(f"Mapping value for {key!r} must be a string")
        mapping[key.strip()] = value
    if not mapping:
        raise SystemExit("Mapping file is empty")
    return mapping


def _cmd_list_form_fields(_args: argparse.Namespace) -> None:
    _save_current_session()
    fields, _roots = _read_docx_form_fields(_working_docx_path())
    _print_json(
        {
            "action": "list-form-fields",
            "count": len(fields),
            "fields": [_serialize_field_occurrence(field) for field in fields],
        }
    )


def _cmd_set_form_field(args: argparse.Namespace) -> None:
    _save_current_session()
    working_docx_path = _working_docx_path()
    fields, xml_roots = _read_docx_form_fields(working_docx_path)
    matches = _ensure_field_targets(fields, name=args.name, default_text=args.default_text)
    updates = [(field, args.text) for field in matches]
    _apply_field_updates(updates)
    _write_docx_roots(working_docx_path, xml_roots)
    session_info = _reopen_working_document()
    _print_json(
        {
            "action": "set-form-field",
            "text": args.text,
            "match_count": len(matches),
            "fields_updated": [_serialize_field_occurrence(field) for field in matches],
            **session_info,
        }
    )


def _cmd_fill_form_fields(args: argparse.Namespace) -> None:
    mapping = _load_mapping(args.mapping)
    _save_current_session()
    working_docx_path = _working_docx_path()
    fields, xml_roots = _read_docx_form_fields(working_docx_path)
    updates: list[tuple[dict[str, object], str]] = []
    for field in fields:
        key = field["name"] if args.by == "name" else field["default_text"]
        if not isinstance(key, str):
            continue
        if key in mapping:
            updates.append((field, mapping[key]))
    if not updates:
        raise SystemExit(f"No form fields matched mapping keys by {args.by}")
    _apply_field_updates(updates)
    _write_docx_roots(working_docx_path, xml_roots)
    session_info = _reopen_working_document()
    _print_json(
        {
            "action": "fill-form-fields",
            "by": args.by,
            "mapping_keys": sorted(mapping.keys()),
            "match_count": len(updates),
            "fields_updated": [
                _serialize_field_occurrence(field)
                for field, _replacement_text in updates
            ],
            **session_info,
        }
    )


def _cmd_flatten_form_fields(args: argparse.Namespace) -> None:
    _save_current_session()
    working_docx_path = _working_docx_path()
    fields, xml_roots = _read_docx_form_fields(working_docx_path)
    if args.name:
        requested_names = {name.strip() for name in args.name if name.strip()}
        matches = [field for field in fields if field["name"] in requested_names]
        matched_names = {str(field["name"]) for field in matches}
        missing_names = sorted(requested_names - matched_names)
        if missing_names:
            raise SystemExit(f"Unknown form field names: {', '.join(missing_names)}")
    else:
        matches = fields
    if not matches:
        raise SystemExit("No form fields matched the flatten request")
    updates = []
    for field in matches:
        current_text = field["current_text"] if isinstance(field["current_text"], str) else ""
        default_text = field["default_text"] if isinstance(field["default_text"], str) else ""
        updates.append((field, current_text or default_text))
    _apply_field_updates(updates)
    _write_docx_roots(working_docx_path, xml_roots)
    session_info = _reopen_working_document()
    _print_json(
        {
            "action": "flatten-form-fields",
            "match_count": len(matches),
            "fields_updated": [_serialize_field_occurrence(field) for field in matches],
            **session_info,
        }
    )


def _cmd_execute_file(args: argparse.Namespace) -> None:
    code = Path(args.path).read_text(encoding="utf-8")
    _print_json(_execute_python(code))


def _cmd_execute_stdin(_args: argparse.Namespace) -> None:
    code = sys.stdin.read()
    if not code.strip():
        raise SystemExit("No Python code provided on stdin")
    _print_json(_execute_python(code))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docx-tool",
        description="Workspace-local helper for the PI DOCX editor",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="Show workspace/session information")

    text_parser = sub.add_parser("text", help="Dump current document text")
    text_parser.add_argument("--out", help="Optional JSON output path")

    structure_parser = sub.add_parser("structure", help="Dump current document structure")
    structure_parser.add_argument("--out", help="Optional JSON output path")

    refresh_parser = sub.add_parser("refresh", help="Refresh current text and structure snapshots")
    refresh_parser.add_argument("--text-out", help="Path for refreshed text JSON")
    refresh_parser.add_argument("--structure-out", help="Path for refreshed structure JSON")

    save_parser = sub.add_parser("save", help="Save the working document")
    save_parser.add_argument("--path", help="Optional save-as path")

    export_parser = sub.add_parser("export-pdf", help="Export the working document as PDF")
    export_parser.add_argument("path", help="Output PDF path")
    export_parser.add_argument("--no-comments", action="store_true")
    export_parser.add_argument("--no-changes", action="store_true")

    screenshot_parser = sub.add_parser("screenshot", help="Render a page screenshot")
    screenshot_parser.add_argument("--page", type=int, default=1)
    screenshot_parser.add_argument("--out", required=True)
    screenshot_parser.add_argument("--no-comments", action="store_true")
    screenshot_parser.add_argument("--no-changes", action="store_true")

    get_ooxml_parser = sub.add_parser("get-ooxml", help="Inspect document OOXML body children")
    get_ooxml_parser.add_argument("--start-child", type=int)
    get_ooxml_parser.add_argument("--end-child", type=int)
    get_ooxml_parser.add_argument("--out", help="Optional JSON output path")

    insert_ooxml_parser = sub.add_parser("insert-ooxml", help="Insert OOXML into the document")
    insert_ooxml_source = insert_ooxml_parser.add_mutually_exclusive_group(required=True)
    insert_ooxml_source.add_argument("--xml", help="OOXML string to insert")
    insert_ooxml_source.add_argument("--file", help="Path to a file containing OOXML to insert")
    insert_ooxml_parser.add_argument(
        "--position",
        default="end",
        help="Insert position: start, end, or after:<index>",
    )

    find_parser = sub.add_parser("find-text", help="Find matching text occurrences by paragraph")
    find_parser.add_argument("--text", required=True)
    find_parser.add_argument(
        "--match",
        choices=["contains", "exact"],
        default="contains",
        help="Paragraph matching mode",
    )

    replace_parser = sub.add_parser(
        "replace-text",
        help="Replace text only when the exact match is unique in the document",
    )
    replace_parser.add_argument("--old", required=True)
    replace_parser.add_argument("--new", required=True)

    replace_all_parser = sub.add_parser("replace-all-text", help="Replace every exact matching text occurrence")
    replace_all_parser.add_argument("--old", required=True)
    replace_all_parser.add_argument("--new", required=True)

    delete_parser = sub.add_parser(
        "delete-text",
        help="Delete text only when the exact match is unique in the document",
    )
    delete_parser.add_argument("--text", required=True)

    delete_all_parser = sub.add_parser("delete-all-text", help="Delete every exact matching text occurrence")
    delete_all_parser.add_argument("--text", required=True)

    append_parser = sub.add_parser("append-paragraph", help="Append a new paragraph")
    append_parser.add_argument("--text", required=True)
    append_parser.add_argument("--style")

    sub.add_parser("accept-all-changes", help="Accept every tracked change in the document")
    sub.add_parser("reject-all-changes", help="Reject every tracked change in the document")

    insert_after_parser = sub.add_parser(
        "insert-after",
        help="Insert a paragraph after an exact paragraph-text anchor",
    )
    insert_after_parser.add_argument("--anchor", required=True)
    insert_after_parser.add_argument("--text", required=True)
    insert_after_parser.add_argument("--style")

    sub.add_parser(
        "list-form-fields",
        help="List legacy Word form fields and their current values",
    )

    set_field_parser = sub.add_parser(
        "set-form-field",
        help="Replace a legacy Word form field with plain text",
    )
    set_field_target = set_field_parser.add_mutually_exclusive_group(required=True)
    set_field_target.add_argument("--name", help="Exact form field name, for example Text1")
    set_field_target.add_argument(
        "--default-text",
        help="Match one or more fields by their placeholder/default text",
    )
    set_field_parser.add_argument("--text", required=True, help="Replacement plain text")

    fill_fields_parser = sub.add_parser(
        "fill-form-fields",
        help="Bulk replace legacy Word form fields from a JSON mapping file",
    )
    fill_fields_parser.add_argument("--mapping", required=True, help="Path to a JSON object mapping keys to text")
    fill_fields_parser.add_argument(
        "--by",
        choices=["name", "default"],
        default="name",
        help="Whether mapping keys match field names or placeholder/default text",
    )

    flatten_fields_parser = sub.add_parser(
        "flatten-form-fields",
        help="Convert one or more legacy Word form fields to plain text using their current displayed values",
    )
    flatten_fields_parser.add_argument(
        "--name",
        action="append",
        default=[],
        help="Optional field name to flatten; repeat to target multiple fields. Defaults to all fields.",
    )

    execute_file_parser = sub.add_parser("execute-file", help="Execute a Python snippet from a file")
    execute_file_parser.add_argument("path")

    sub.add_parser("execute-stdin", help="Execute a Python snippet from stdin")

    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    command = args.command
    if command == "info":
        _cmd_info(args)
    elif command == "text":
        _cmd_text(args)
    elif command == "structure":
        _cmd_structure(args)
    elif command == "refresh":
        _cmd_refresh(args)
    elif command == "save":
        _cmd_save(args)
    elif command == "export-pdf":
        _cmd_export_pdf(args)
    elif command == "screenshot":
        _cmd_screenshot(args)
    elif command == "get-ooxml":
        _cmd_get_ooxml(args)
    elif command == "insert-ooxml":
        _cmd_insert_ooxml(args)
    elif command == "find-text":
        _cmd_find_text(args)
    elif command == "replace-text":
        _cmd_replace_text(args)
    elif command == "replace-all-text":
        _cmd_replace_all_text(args)
    elif command == "delete-text":
        _cmd_delete_text(args)
    elif command == "delete-all-text":
        _cmd_delete_all_text(args)
    elif command == "append-paragraph":
        _cmd_append_paragraph(args)
    elif command == "accept-all-changes":
        _cmd_accept_all_changes(args)
    elif command == "reject-all-changes":
        _cmd_reject_all_changes(args)
    elif command == "insert-after":
        _cmd_insert_after(args)
    elif command == "list-form-fields":
        _cmd_list_form_fields(args)
    elif command == "set-form-field":
        _cmd_set_form_field(args)
    elif command == "fill-form-fields":
        _cmd_fill_form_fields(args)
    elif command == "flatten-form-fields":
        _cmd_flatten_form_fields(args)
    elif command == "execute-file":
        _cmd_execute_file(args)
    elif command == "execute-stdin":
        _cmd_execute_stdin(args)
    else:
        parser.error(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
