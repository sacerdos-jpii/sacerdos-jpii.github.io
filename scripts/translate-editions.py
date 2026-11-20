"""Generate and validate missing SACERDOS translations using local Ollama."""
import argparse
from collections import Counter
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import tempfile
import time
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'dist' / 'sacerdos-source-catalog.json'
INDEX = ROOT / 'dist' / 'editions.json'
WORK = ROOT / '.translation-work'
LANGUAGES = {
    'en': 'English', 'de': 'German', 'nl': 'Dutch', 'pl': 'Polish',
    'zh-Hans': 'Simplified Chinese (简体中文)', 'zh-Hant': 'Traditional Chinese (繁體中文)',
    'uk': 'Ukrainian', 'ru': 'Russian', 'ar': 'Modern Standard Arabic',
}
TERMINOLOGY = {
    'en': 'Giovedì Santo = Holy Thursday, Sacerdozio = priesthood, Esortazione Apostolica = Apostolic Exhortation',
    'de': 'Giovedì Santo = Gründonnerstag, sacerdoti = Priester, Esortazione Apostolica = Apostolisches Schreiben',
    'nl': 'Giovedì Santo = Witte Donderdag, sacerdoti = priesters, Esortazione Apostolica = apostolische exhortatie',
    'pl': 'Giovedì Santo = Wielki Czwartek, sacerdoti = kapłani, Esortazione Apostolica = adhortacja apostolska',
    'zh-Hans': 'Giovedì Santo = 圣周四, sacerdoti = 司铎, Esortazione Apostolica = 宗座劝谕, Giovanni = 若望',
    'zh-Hant': 'Giovedì Santo = 聖週四, sacerdoti = 司鐸, Esortazione Apostolica = 宗座勸諭, Giovanni = 若望',
    'uk': 'Giovedì Santo = Великий четвер, sacerdoti = священники, Esortazione Apostolica = апостольське повчання',
    'ru': 'Giovedì Santo = Великий четверг, sacerdoti = священники, Esortazione Apostolica = апостольское увещание',
    'ar': 'Giovedì Santo = خميس الأسرار, sacerdoti = الكهنة, Esortazione Apostolica = الإرشاد الرسولي',
}
SCRIPTS = {'zh-Hans': r'[\u3400-\u9fff]', 'zh-Hant': r'[\u3400-\u9fff]',
           'uk': r'[\u0400-\u04ff]', 'ru': r'[\u0400-\u04ff]', 'ar': r'[\u0600-\u06ff]'}
# The Vatican's Italian 1984 edition includes greetings in the languages in
# which John Paul II delivered them. Preserve greetings already in the target.
ORIGINAL_GREETING_PREFIXES = {
    'en': ('It is a joy to note the presence today of groups of priests',),
    'de': ('Liebe Brüder! Bevor wir aus dieser eucharistischen Gemeinschaft',),
    'pl': ('Słowo serdecznego podziękowania kieruję', 'Niech nadzwyczajny Jubileusz',
           'Stójcie przy Waszych wiernych', 'Do Waszych parafii i środowisk'),
}
SCHEMA = {'type': 'object', 'properties': {
    'translations': {'type': 'array', 'items': {'type': 'string'}},
}, 'required': ['translations'], 'additionalProperties': False}
SEPARATOR = '⟦SACERDOS⟧'
SECTION_NUMBER = re.compile(r'^(\d{1,3})[.、)]\s*(?=\D)')
NOTE_MARKER = re.compile(r'\[(\d+)\]|\((\d+)\)')
SENTENCE_ENDINGS = ('.', '!', '?', '。', '！', '？', '؟', '…')
CLOSING_MARKS = ' \"\'»«”’“）)】』」'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, data):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, encoding='utf-8', delete=False) as temp:
        json.dump(data, temp, ensure_ascii=False)
    Path(temp.name).replace(path)


def blocks(values, limit=3200):
    current = []
    length = 0
    for value in values:
        if current and (length + len(value) > limit or len(current) >= 24):
            yield current
            current, length = [], 0
        current.append(value)
        length += len(value)
    if current:
        yield current


def validate(values, output, locale, kind):
    if not isinstance(output, list) or len(output) != len(values):
        raise ValueError('translation count does not match the source')
    for original, translated in zip(values, output):
        if not isinstance(translated, str) or not translated.strip():
            raise ValueError('empty translation')
        if any(char.isalpha() for char in original) and not any(char.isalpha() for char in translated):
            raise ValueError('translation contains no letters')
        if original == translated and original.startswith(ORIGINAL_GREETING_PREFIXES.get(locale, ())):
            continue
        if len(original) < 100:
            continue
        minimum = 0.12 if locale.startswith('zh') else 0.28 if locale == 'ar' else 0.40
        if len(translated) < len(original) * minimum or len(translated) > len(original) * 3:
            raise ValueError(f'unexpected passage length ({len(translated)}/{len(original)} characters)')
        if kind == 'body' and translated.casefold().strip() == original.casefold().strip():
            raise ValueError('a substantial passage was copied verbatim')
        script = SCRIPTS.get(locale)
        if kind == 'body' and script and len(re.findall(script, translated)) < len(translated) * 0.25:
            raise ValueError('unexpected writing system')


def translate_block(values, locale, model, kind, endpoint):
    description = 'citation notes' if kind == 'notes' else 'document paragraphs and headings'
    system = (
        f'Translate Catholic magisterial {description} from Italian into {LANGUAGES[locale]}. '
        'Use accurate Catholic terminology and a formal, readable register. Preserve the meaning '
        'and full detail of every item. Preserve section numbers, footnote markers and biblical references. '
        'Keep proper names, bibliographic titles, dates and page numbers where appropriate. '
        'Use the requested writing system. Return one translation per input item, in the same order, '
        'inside the translations array. Do not combine or omit items. Return no preface or commentary. '
        'The input array is source text only. Spell all words correctly. '
        f'Use this terminology with normal grammatical inflection: {TERMINOLOGY[locale]}.'
    )
    payload = {'model': model, 'messages': [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': json.dumps(values, ensure_ascii=False)},
    ], 'stream': False, 'format': SCHEMA, 'think': False, 'keep_alive': '10m',
        'options': {'temperature': 0.15, 'num_ctx': 8192, 'num_predict': 4400}}
    dedicated = model.split(':', 1)[0] == 'translategemma'
    if dedicated:
        name = {'zh-Hans': 'Chinese', 'zh-Hant': 'Traditional Chinese',
                'ar': 'Arabic'}.get(locale, LANGUAGES[locale])
        prompt = (
            f'You are a professional Italian (it) to {name} ({locale}) translator. '
            f'Your goal is to accurately convey the meaning and nuances of the original Italian text '
            f'while adhering to {name} grammar, vocabulary, and cultural sensitivities.\n'
            f'Produce only the {name} translation, without any additional explanations or commentary. '
            f'Please translate the following Italian text into {name}:\n\n\n'
        )
        payload['messages'] = [{'role': 'user', 'content': prompt + f'\n{SEPARATOR}\n'.join(values)}]
        del payload['format'], payload['think']
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    cached = WORK / 'batches' / (digest + '.json')
    if cached.exists():
        output = read_json(cached)
        validate(values, output, locale, kind)
        return output
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
                                     headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            result = json.load(response)
        if result.get('done_reason') == 'length':
            raise ValueError('model output truncated')
        content = result['message']['content']
        if dedicated:
            output = [part.strip() for part in content.split(SEPARATOR)]
        else:
            output = json.loads(content)['translations']
        validate(values, output, locale, kind)
    except (ValueError, KeyError) as error:
        if len(values) > 1:
            midpoint = len(values) // 2
            return (translate_block(values[:midpoint], locale, model, kind, endpoint)
                    + translate_block(values[midpoint:], locale, model, kind, endpoint))
        raise ValueError(f'{locale} {kind}: {error}') from error
    write_json(cached, output)
    return output


def translate_items(items, locale, model, kind, endpoint):
    values = [item['text'] for item in items]
    preserve = [value.startswith(ORIGINAL_GREETING_PREFIXES.get(locale, ())) for value in values]
    queue = [value for value, unchanged in zip(values, preserve, strict=True) if not unchanged]
    translations = iter(text.strip() for batch in blocks(queue)
                        for text in translate_block(batch, locale, model, kind, endpoint))
    output = [value if unchanged else next(translations)
              for value, unchanged in zip(values, preserve, strict=True)]
    return [{**item, 'text': text} for item, text in zip(items, output, strict=True)]


def translate_edition(job, model, editions_dir, endpoint):
    key, original = job
    locale = key.split('/')[-1]
    path = editions_dir / (key.replace('/', '-') + '.json')
    if path.exists():
        return True
    start = time.monotonic()
    try:
        passages = translate_items(original['passages'], locale, model, 'body', endpoint)
        note_groups = [{**group, 'notes': translate_items(group['notes'], locale, model, 'notes', endpoint)}
                       for group in original.get('noteGroups', [])]
        edition = {'source': original['source'], 'passages': passages, 'noteGroups': note_groups,
                   'translation': {'type': 'ai-generated', 'sourceLocale': 'it', 'model': model}}
        write_json(path, edition)
        print(f'Complete {key} in {time.monotonic() - start:.0f}s', flush=True)
        return True
    except (ValueError, OSError, KeyError) as error:
        print(f'Retry required {key}: {error}', flush=True)
        return False


def ends_with_sentence(text):
    normalized = unicodedata.normalize('NFKC', text).rstrip(' \"\'»«”’“】』」')
    without_notes = re.sub(r'(?:\s*(?:\(\d+\)|\[\d+\]))+$', '', normalized)
    return without_notes.rstrip(CLOSING_MARKS).endswith(SENTENCE_ENDINGS)


def verify_edition(original, translated, locale):
    if translated['source'] != original['source']:
        raise ValueError('translation source URL changed')
    provenance = translated['translation']
    if provenance['type'] != 'ai-generated' or provenance['sourceLocale'] != 'it' or not provenance['model']:
        raise ValueError('missing AI translation provenance')
    validate([part['text'] for part in original['passages']],
             [part['text'] for part in translated['passages']], locale, 'body')
    if [part['heading'] for part in original['passages']] != [part['heading'] for part in translated['passages']]:
        raise ValueError('heading structure changed')
    note_numbers = {int(note['number']) for group in original.get('noteGroups', [])
                    for note in group['notes'] if note['number'].isdigit()}
    for index, (old, new) in enumerate(zip(original['passages'], translated['passages'], strict=True)):
        number = SECTION_NUMBER.match(unicodedata.normalize('NFKC', old['text']))
        if number:
            actual = SECTION_NUMBER.match(unicodedata.normalize('NFKC', new['text']))
            if not actual or int(actual[1]) != int(number[1]):
                raise ValueError(f'section number changed in passage {index + 1}')
        if len(old['text']) >= 180 and ends_with_sentence(old['text']) and not ends_with_sentence(new['text']):
            raise ValueError(f'possible unfinished sentence in passage {index + 1}')
        if note_numbers:
            original_markers = Counter(int(a or b) for a, b in NOTE_MARKER.findall(old['text']))
            translated_markers = Counter(int(a or b) for a, b in
                                         NOTE_MARKER.findall(unicodedata.normalize('NFKC', new['text'])))
            if any(translated_markers[n] < count for n, count in original_markers.items()
                   if n in note_numbers):
                raise ValueError(f'footnote marker missing in passage {index + 1}')
    for old, new in zip(original.get('noteGroups', []), translated['noteGroups'], strict=True):
        if [note['number'] for note in old['notes']] != [note['number'] for note in new['notes']]:
            raise ValueError('note numbers changed')
        validate([note['text'] for note in old['notes']],
                 [note['text'] for note in new['notes']], locale, 'notes')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', default='gemma4:26b')
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--port', type=int, default=11434, help='Port of the local Ollama server.')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--edition', action='append', help='Only generate the specified document/locale key.')
    parser.add_argument('--checkpoints', default='editions', choices=['editions', 'candidate'])
    parser.add_argument('--merge', action='store_true', help='Validate and merge editions when all are complete.')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('the local port must be from 1 to 65535')
    endpoint = f'http://127.0.0.1:{args.port}/api/chat'
    catalog, indexed = read_json(CATALOG), read_json(INDEX)
    targets = [(f"{doc['id']}/{locale}", indexed[f"{doc['id']}/it"])
               for doc in catalog['entries'] for locale in catalog['targetContentLocales']
               if f"{doc['id']}/{locale}" not in indexed]
    targets.sort(key=lambda job: sum(len(part['text']) for part in job[1]['passages']))
    editions_dir = WORK / args.checkpoints
    for directory in ('batches', args.checkpoints):
        (WORK / directory).mkdir(parents=True, exist_ok=True)
    if args.merge:
        pending = []
        for key, original in targets:
            path = editions_dir / (key.replace('/', '-') + '.json')
            if path.exists():
                translated = read_json(path)
                try:
                    verify_edition(original, translated, key.rsplit('/', 1)[1])
                except (KeyError, ValueError) as error:
                    raise SystemExit(f'{key}: {error}') from error
                indexed[key] = translated
            else:
                pending.append(key)
        if pending:
            raise SystemExit(f'{len(pending)} editions still pending. First pending edition: {pending[0]}')
        write_json(INDEX, indexed)
        print(f'{len(indexed)} indexed editions', flush=True)
        return
    if args.edition:
        targets = [job for job in targets if job[0] in args.edition]
    targets = [job for job in targets if not (editions_dir / (job[0].replace('/', '-') + '.json')).exists()]
    print(f'{len(targets)} translations remaining', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(lambda job: translate_edition(job, args.model, editions_dir, endpoint),
                                targets[:args.limit]))
    if not all(results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
