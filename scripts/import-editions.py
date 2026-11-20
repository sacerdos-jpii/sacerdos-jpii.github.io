"""Import catalog editions into a plain-text, source-attributed reading index."""
import concurrent.futures
import argparse
import json
import re
import subprocess
from html import unescape
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1] / 'dist'
CATALOG = json.loads((ROOT / 'sacerdos-source-catalog.json').read_text())
NOTE_LABEL = re.compile(r'^(?:notes?|notas|anmerkungen|referencias)\s*:?$', re.I)
NOTE_NUMBER = re.compile(r'^(?:\[(\d+)\]|\((\d+)(?:\)\.?|[. ]\s*)|(\d+)\.?\s+|([*]))\s*(.+)$')
CHINESE_SECTION = re.compile(r'^\s*(引言|第[一二三四五六]章[^\n]*|结论)\s*$', re.M)


def plain(value):
    return ' '.join(unescape(re.sub(r'<[^>]+>', '', value)).split())


def note_match(text):
    match = NOTE_NUMBER.fullmatch(text)
    if match:
        return next(value for value in match.groups()[:4] if value), match[5]
    return None


def split_endnotes(passages, key):
    end = len(passages)
    while end and 'Copyright' in passages[end - 1]['text'][:32]:
        end -= 1
    for start, part in enumerate(passages[:end]):
        value = part['text']
        if NOTE_LABEL.fullmatch(value):
            first = start + 1
        elif value.startswith('*Este año el Papa'):
            first = start
        elif start >= end // 3 and (
            value.startswith(('(1)', '[1]')) or key == 'holy-thursday-1987/en'
        ) and note_match(value) and note_match(value)[0] == '1':
            next_note = note_match(passages[start + 1]['text']) if start + 1 < end else None
            if not next_note or next_note[0] != '2':
                continue
            first = start
        else:
            continue
        notes = []
        for part in passages[first:end]:
            match = note_match(part['text'])
            if match:
                notes.append({'number': match[0], 'text': match[1]})
            elif notes:
                notes[-1]['text'] += ' ' + part['text']
        if notes:
            return passages[:start] + passages[end:], [{'notes': notes}]
    return passages, []


def chinese_exhortation(decoded):
    # This edition restarts the note numbers at the end of each chapter.
    decoded = re.sub(r'(?m)^ +\d+ *$', '', decoded).replace('\f', '\n')
    headings = list(CHINESE_SECTION.finditer(decoded))
    headings = headings[8:]  # The first eight headings belong to the contents page.
    if len(headings) != 8:
        raise ValueError('unexpected Simplified Chinese chapter layout')
    passages = [{'text': '我要给你们牧者', 'heading': True}]
    groups = []
    for i, heading in enumerate(headings):
        title = heading[1].strip()
        end = headings[i + 1].start() if i + 1 < len(headings) else len(decoded)
        section = decoded[heading.end():end]
        note_start = re.search(r'(?m)^ *(?:注[：:]? *\n)? *\(1\)(?=\D)', section)
        if note_start:
            note_text = section[note_start.start():]
            markers = list(re.finditer(r'(?m)^ *\((\d+)\) *', note_text))
            notes = []
            for j, marker in enumerate(markers):
                stop = markers[j + 1].start() if j + 1 < len(markers) else len(note_text)
                notes.append({'number': marker[1], 'text': ' '.join(note_text[marker.end():stop].split())})
            groups.append({'title': title, 'notes': notes})
            section = section[:note_start.start()]
        group = len(groups) - 1 if note_start else None
        passages.append({'text': title, 'heading': True})
        for paragraph in re.split(r'\n\s*\n|\n(?= +\S)', section):
            value = ' '.join(paragraph.split())
            if value:
                passages.append({'text': value, 'heading': False, 'noteGroup': group})
    return passages, groups


def html_passages(page, host):
    page = re.sub(r'<(script|style|noscript)\b[^>]*>.*?</\1>', '', page, flags=re.I | re.S)
    if host.endswith('.vatican.va'):
        section = page.partition('<div class="testo">')[2].partition('<p class="copyright">')[0]
    elif host.endswith('.clerus.va'):
        section = re.search(r'<main\b[^>]*>(.*?)</main>', page, re.I | re.S)
        section = section.group(1) if section else ''
    elif host.endswith('.clerus.org'):
        section = re.split(r'<body\b[^>]*>', page, maxsplit=1, flags=re.I)[-1]
    elif host == 'rkdocumenten.nl':
        blocks = re.findall(r'<div class="tekstregel"[^>]*>(.*?)</div>', page, re.S)
        passages = []
        for block in dict.fromkeys(blocks):
            block = re.sub(r'<span class="popuptext"[^>]*>.*?</span>', '', block, flags=re.S)
            heading = re.search(r'<span class="alineatitel">(.*?)</span>', block, re.S)
            if heading:
                passages.append({'text': plain(heading[1]), 'heading': True})
                block = block.replace(heading[0], '', 1)
            for paragraph in re.split(r'(?:<br\s*/?>\s*){2,}|</blockquote>', block):
                value = plain(re.sub(r'<br\s*/?>', ' ', paragraph))
                if value:
                    passages.append({'text': value, 'heading': False})
        return passages
    else:
        section = re.search(r'<(?:article|main)\b[^>]*>(.*?)</(?:article|main)>', page, re.I | re.S)
        section = section.group(1) if section else ''
    separator = re.search(r'<hr\b[^>]*>\s*(?:&nbsp;\s*)?(?=<(?:p|div)\b)', section, re.I)
    if separator:
        tail = section[separator.end():]
        if re.match(r'(?:(?:notes?|notas|referencias|anmerkungen)\b|\(1\)|\[1\])', plain(tail), re.I):
            tail = re.sub(r'(</p>)(\s*)(?=\(\s*(?:<a\b[^>]*>)?\d+(?:</a>)?\))',
                          r'\1\2<p>', tail, flags=re.I)
            tail = tail.replace('342 . 399 Cf <i>Gv</i>', '342 .</p><p>(399) Cf <i>Gv</i>')
            section = section[:separator.end()] + tail
    blocks = re.findall(r'<(p|h[1-6])\b[^>]*>(.*?)(?=</(?:p|h[1-6])\s*>|<(?:p|h[1-6])\b|$)', section, re.I | re.S)
    passages = []
    for tag, body in blocks:
        body = re.sub(r'<br\s*/?>', ' ', body, flags=re.I)
        body = re.sub(r'<sup\b[^>]*>(.*?)</sup>',
                      lambda match: '[' + plain(match[1]) + ']' if plain(match[1]).isdigit() else match[0],
                      body, flags=re.I | re.S)
        value = plain(body)
        if value:
            heading = tag.lower().startswith('h') or (
                len(value) < 180 and re.fullmatch(r'\s*<(?:b|strong)>.*</(?:b|strong)>\s*', body, re.I | re.S)
            )
            passages.append({'text': value, 'heading': bool(heading)})
    return passages


def import_edition(job):
    document, edition, source_directory = job
    url = edition['url']
    key = f"{document['id']}/{edition['locale']}"
    try:
        data = (source_directory / (key.replace('/', '-') + '.' + edition['format'])).read_bytes() if source_directory else subprocess.check_output(
            ['curl', '-fsSL', '--proto', '=https', '--max-time', '28', url],
            stderr=subprocess.PIPE,
        )
        if edition['format'] == 'pdf':
            chinese = key == 'pastores-dabo-vobis/zh-Hans'
            options = ['-layout'] if chinese else []
            decoded = subprocess.check_output(['pdftotext', *options, '-', '-'], input=data).decode()
            if chinese:
                passages, notes = chinese_exhortation(decoded)
            else:
                passages = [{'text': ' '.join(p.split()), 'heading': False}
                            for p in re.split(r'\n\s*\n', decoded) if p.strip() and not p.strip().isdigit()]
                notes = []
        else:
            encoding = re.search(rb'charset\s*=\s*["\']?([\w-]+)', data[:9000], re.I)
            charset = encoding.group(1).decode() if encoding else 'utf-8'
            try:
                decoded = data.decode(charset)
            except (LookupError, UnicodeDecodeError):
                decoded = data.decode('windows-1252', errors='replace')
            passages = html_passages(decoded, urlsplit(url).hostname)
            passages, notes = split_endnotes(passages, key)
        if len(passages) < 4 or sum(len(p['text']) for p in passages) < 650:
            raise ValueError('no usable document body')
        return key, {'source': url, 'passages': passages, 'noteGroups': notes}
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'{key}: {error}', flush=True)
        return key, None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-directory', type=Path, help='Read previously downloaded source files.')
    args = parser.parse_args()
    jobs = [(doc, edition, args.source_directory) for doc in CATALOG['entries'] for edition in doc['editions']
            if edition['locale'] in CATALOG['targetContentLocales']]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        editions = {key: value for key, value in pool.map(import_edition, jobs) if value}
    imported = len(editions)
    index = ROOT / 'editions.json'
    if index.exists():
        expected = {f"{doc['id']}/{locale}" for doc in CATALOG['entries']
                    for locale in CATALOG['targetContentLocales']}
        for key, existing in json.loads(index.read_text(encoding='utf-8')).items():
            if key in expected and existing.get('translation', {}).get('type') == 'ai-generated':
                editions.setdefault(key, existing)
    index.write_text(json.dumps(editions, ensure_ascii=False), encoding='utf-8')
    print(f'Imported {imported} of {len(jobs)} catalog editions in target languages.')
