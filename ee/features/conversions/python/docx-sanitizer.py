#!/usr/bin/env python3
"""
Minimal DOCX Sanitizer — only unwraps <w:sdt> blocks.

Google Docs exports wrap content in structured document tag (<w:sdt>) blocks
for suggested-edit tracking (goog_rdk_*) and TOC wrappers. LibreOffice crashes
on these — especially empty ones. This script unwraps them, keeping the inner
content intact and touching nothing else.

Usage:
    python docx-sanitizer.py input.docx [output.docx]
    python docx-sanitizer.py -v input.docx

If output is omitted, the input file is overwritten in place.
"""

import sys
import os
import re
import logging
import zipfile
import tempfile
import argparse

log = logging.getLogger("docx-sanitizer")


def unwrap_sdt(content: str) -> str:
    """Replace <w:sdt>...<w:sdtContent>X</w:sdtContent></w:sdt> with X."""
    count = 0
    while '<w:sdt>' in content:
        old = content
        content = re.sub(
            r'<w:sdt><w:sdtPr>.*?</w:sdtPr><w:sdtContent>(.*?)</w:sdtContent></w:sdt>',
            r'\1',
            content,
            count=1,
            flags=re.DOTALL,
        )
        if content == old:
            break
        count += 1
    return content, count


def sanitize_docx(input_path: str, output_path: str) -> bool:
    try:
        input_size = os.path.getsize(input_path)
        log.info("Input: %s (%d bytes)", input_path, input_size)

        with tempfile.TemporaryDirectory() as tmp:
            with zipfile.ZipFile(input_path, 'r') as z:
                z.extractall(tmp)

            doc_path = os.path.join(tmp, 'word', 'document.xml')
            if not os.path.exists(doc_path):
                log.error("No word/document.xml found")
                return False

            with open(doc_path, 'r', encoding='utf-8') as f:
                content = f.read()

            new_content, count = unwrap_sdt(content)

            if count:
                log.info("Unwrapped %d <w:sdt> block(s) (removed %d bytes)",
                         count, len(content) - len(new_content))
                with open(doc_path, 'w', encoding='utf-8') as f:
                    f.write(new_content)
            else:
                log.info("No <w:sdt> blocks found — file unchanged")

            # Repackage with [Content_Types].xml first
            entries = []
            ct_entry = None
            for root, _dirs, files in os.walk(tmp):
                for file in files:
                    fp = os.path.join(root, file)
                    arc = os.path.relpath(fp, tmp)
                    if arc == '[Content_Types].xml':
                        ct_entry = (fp, arc)
                    else:
                        entries.append((fp, arc))
            if ct_entry:
                entries.insert(0, ct_entry)

            with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as z:
                for fp, arc in entries:
                    z.write(fp, arc)

            output_size = os.path.getsize(output_path)
            log.info("Output: %s (%d bytes, %+d)", output_path, output_size, output_size - input_size)
            return True

    except Exception as e:
        log.exception("Error: %s", e)
        return False


def main():
    parser = argparse.ArgumentParser(description="Minimal DOCX sanitizer — unwrap sdt blocks only")
    parser.add_argument("input", help="Input .docx file")
    parser.add_argument("output", nargs="?", default=None, help="Output .docx (default: overwrite input)")
    parser.add_argument("-v", "--verbose", action="count", default=0)
    args = parser.parse_args()

    level = logging.WARNING
    if args.verbose >= 2:
        level = logging.DEBUG
    elif args.verbose >= 1:
        level = logging.INFO
    logging.basicConfig(level=level, format="%(levelname)-5s %(message)s", stream=sys.stderr)

    if not os.path.exists(args.input):
        log.error("File not found: %s", args.input)
        sys.exit(1)

    output = args.output or args.input
    if sanitize_docx(args.input, output):
        print(f"Sanitized DOCX written to: {output}")
    else:
        sys.exit(1)


if __name__ == '__main__':
    main()
