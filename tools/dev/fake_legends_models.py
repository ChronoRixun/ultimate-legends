"""A stand-in for the character-model tool (legends-models, LAUNCHER-API.md, API 1) for the launcher's
tests: it speaks the tool's command line and JSON-lines protocol and keeps its on-disk rules, but it
converts nothing and reads no game. Its "models" are a few bytes of text; the costume names past the
first two are made up. Nothing here is a game asset.

    python fake_legends_models.py <scan|plan|build|verify|remove|fetch> --json --port DIR --work DIR
        [--mua1 DIR] [--mua2 DIR] [--mode M] [--costume hero=[tier:]ID]... [--hero H]... [--pack P]
        [--mirror URL] [--rebuild] [--offline]

tools/dev/fake-legends-models.cmd runs it for the launcher (the Debug-only models-tool property of the
xml1 entry points at the .cmd). What it does, like the real tool:
  scan    the port is found when it has Actors\\; MUA1 / MUA2 when their folder exists (the launcher
          passes the folders of its mua / mua2 entries); per hero the tiers, their reasons and costumes,
          each tier's author and costume_info [{id, label, author, credit, source_url?, bytes?, preview?}]
          (preview: a small PNG the stand-in draws once that costume was "downloaded")
  plan    per hero the first available tier of the mode's order (upgraded: mua2 > mua1 > community);
          with --offline a community costume not in the download cache is unavailable ("... is not in the
          download cache (offline)") and the hero falls to its next tier or stock
  build   the plan event, then per hero: stage, a community download (archive, source, bytes, sha256,
          character, costume), progress and a gate; writes group-qualified folders (Community-Beast for
          Models-Community, Upgraded-MUA-Storm / Upgraded-Community-Beast for Models-Upgraded; staged in a
          "."-folder, then renamed) with legends-models.json (port_build: the SHA-256 of the port files it
          was made for), mod.json, readme.txt, CREDITS.md and Actors\\<skin>.IGB, sets +Folder in
          mods\\load-order.txt and -Folder for the other legends-models groups, keeping every other line
          byte for byte; first renames this group's 0.2.x-named folders (stage "renamed <old> to <new>
          (group-qualified folder names)", the load-order line renamed in place); the result names
          characters / refused / stock; exit 0, or 10 when some heroes stayed stock, 11 when none passed
  verify  re-hashes the group's folders against their markers (exit 30 on a mismatch), then their port
          files (stale, stale_folders, port_changed, port_build_unknown; exit 31 when stale)
  remove  deletes the group's folders (only ones with the marker: exit 40 otherwise) and their lines
  fetch   (offline only) exit 20
Knobs (environment, or the same names without FAKE_LM_ in <work>\fake-knobs.json): FAKE_LM_DELAY seconds per hero (default 0.6); FAKE_LM_FAIL heroes whose gate fails
at every tier (comma list); FAKE_LM_BUILD_EXIT forces a build's exit code (20: a download refusal,
3: a missing helper) after its plan; FAKE_LM_LOG appends each command line to a file.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

API = 1
START = time.monotonic()
GENERATOR = 'legends-models'
MARKER = 'legends-models.json'
AUTHOR = 'BaconWizard17'
PACKS = {'community': 'Models-Community', 'upgraded': 'Models-Upgraded', 'xml2': 'Models-XML2-Look', 'sharpen': 'Models-Sharpened'}
ORDER = {'upgraded': ['mua2', 'mua1', 'community'], 'community': ['community'], 'xml2': ['xml2'], 'sharpen': ['sharpen']}
FOLDER_PREFIX = {'mua2': 'MUA2', 'mua1': 'MUA', 'xml2': 'XML2', 'community': 'Community', 'sharpen': 'Sharpened'}

# key, name, skin, {tier: [costumes]} - roster facts only (costume IDs past the real defaults are invented)
WOLVERINE_COMMUNITY = ['Original', 'Ultimate XML1'] + [f'Variant {n:02d}' for n in range(3, 20)]
ROSTER = [
    ('beast', 'Beast', '14501', {'community': ['Classic', 'Astonishing'], 'xml2': ['0501'], 'sharpen': ['14501']}),
    ('colossus', 'Colossus', '14901', {'mua1': ['7801'], 'community': ['Ultimate XML1', 'Original'], 'sharpen': ['14901']}),
    ('cyclops', 'Cyclops', '14101', {'community': ['Ultimate XML1', 'Classic'], 'sharpen': ['14101']}),
    ('frost', 'Emma Frost', '15501', {'community': ['Ultimate XML1'], 'xml2': ['1501'], 'sharpen': ['15501']}),
    ('gambit', 'Gambit', '15301', {'community': ['Ultimate XML1', 'Classic'], 'sharpen': ['15301']}),
    ('iceman', 'Iceman', '14701', {'mua1': ['1001', '1002'], 'community': ['Ultimate XML1'], 'sharpen': ['14701']}),
    ('jubilee', 'Jubilee', '15701', {'community': ['Ultimate XML1'], 'xml2': ['1601'], 'sharpen': ['15701']}),
    ('magma', 'Magma', '15101', {'community': ['Original', 'Ultimate XML1'], 'xml2': ['1801'], 'sharpen': ['15101']}),
    ('nightcrawler', 'Nightcrawler', '14401', {'mua1': ['0901', '0902'], 'community': ['Ultimate XML1'], 'sharpen': ['14401']}),
    ('phoenix', 'Jean Grey', '14801', {'mua1': ['1201'], 'community': ['Phoenix'], 'sharpen': ['14801']}),
    ('profxastral', 'Professor X (astral)', '13301', {'sharpen': ['13301']}),
    ('psylocke', 'Psylocke', '15901', {'mua1': ['1401'], 'community': ['Ultimate XML1'], 'sharpen': ['15901']}),
    ('rogue', 'Rogue', '15601', {'community': ['Ultimate XML1'], 'xml2': ['0701'], 'sharpen': ['15601']}),
    ('storm', 'Storm', '14601', {'mua1': ['0601', '0602'], 'community': ['Ultimate XML1'], 'sharpen': ['14601']}),
    ('wolverine', 'Wolverine', '14301', {'mua2': ['0301'], 'mua1': ['0303', '0301', '0302'], 'community': WOLVERINE_COMMUNITY,
                                         'xml2': ['0301'], 'sharpen': ['14301']}),
]
HEROES = {key: (name, skin, tiers) for key, name, skin, tiers in ROSTER}
# The groups whose own tier keeps the short folder name (LAUNCHER-API.md "Folder names (0.3.0)").
OWN_GROUP = {'community': 'Models-Community', 'xml2': 'Models-XML2-Look', 'sharpen': 'Models-Sharpened'}
LABELS = {('wolverine', 'mua1', '0303'): 'Classic yellow/blue', ('wolverine', 'mua1', '0301'): 'White shirt and jeans',
          ('wolverine', 'mua1', '0302'): 'Brown/yellow', ('wolverine', 'mua2', '0301'): 'Default'}
GAME_CREDIT = {'mua1': 'from your own copy of Marvel: Ultimate Alliance', 'mua2': 'from your own copy of Marvel: Ultimate Alliance 2',
               'xml2': "X-Men Legends II's own model (already in the port)", 'sharpen': "the port's own textures, sharpened on this PC"}
TIER_WORD = {'mua1': 'MUA1', 'mua2': 'MUA2', 'xml2': 'XML2'}
THREAD = 'https://marvelmods.com/forum/index.php/topic,10629.0.html'


def folder_name(group, tier, hero):
    base = f'{FOLDER_PREFIX[tier]}-{HEROES[hero][0].replace(" ", "").replace("(", "").replace(")", "")}'
    if OWN_GROUP.get(tier) == group:
        return base
    prefix = group[len('Models-'):] if group.startswith('Models-') else group
    return f'{prefix}-{base}'


def png(width, height, rgb):
    """A small solid-colour PNG with a darker frame, drawn here (a stand-in preview, not a game asset)."""
    import struct
    import zlib
    dark = tuple(c // 3 for c in rgb)
    rows = b''.join(b'\0' + b''.join(bytes(dark if x < 3 or y < 3 or x >= width - 3 or y >= height - 3 else rgb)
                                      for x in range(width)) for y in range(height))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def port_work(args):
    return Path(args.work) / 'ports' / hashlib.sha256(str(args.port).casefold().encode()).hexdigest()[:12]


def preview_path(args, hero, costume):
    folder = port_work(args) / 'community' / 'extracted' / hero / costume.lower().replace(' ', '-')
    return folder / f'{HEROES[hero][0]} {costume} (Character Select Portrait).png'


def costume_info(args, hero, tier, costumes):
    out = []
    for c in costumes:
        if tier == 'community':
            row = dict(id=c, label=c, author=AUTHOR, credit=f'by {AUTHOR} (marvelmods.com)', source_url=THREAD, bytes=1048576)
            p = preview_path(args, hero, c)
            if p.is_file():
                row['preview'] = str(p)
        else:
            label = LABELS.get((hero, tier, c)) or ('Sharpened original' if tier == 'sharpen' else f'{TIER_WORD.get(tier, tier)} costume {c}')
            row = dict(id=c, label=label, author='', credit=GAME_CREDIT.get(tier, ''))
        out.append(row)
    return out


def knob(name, default=''):
    """FAKE_LM_<name> from the environment, else from <work>\fake-knobs.json (the CDP test writes it: a
    running launcher's environment can't be changed)."""
    value = os.environ.get(f'FAKE_LM_{name}')
    if value is not None:
        return value
    return str(KNOBS.get(name, default))


KNOBS = {}


def emit(event, **data):
    print(json.dumps(dict(event=event, api=API, t=round(time.monotonic() - START, 3), **data)), flush=True)


def fail(message, code):
    emit('error', message=message, code=code)
    return code


def parser():
    p = argparse.ArgumentParser(prog='legends-models')
    p.add_argument('command', choices=['scan', 'plan', 'build', 'verify', 'remove', 'fetch'])
    p.add_argument('--json', action='store_true')
    for flag in ('--port', '--work', '--mua1', '--mua2', '--steam', '--game', '--mode', '--pack', '--mirror', '--python', '--layout',
                 '--manifest', '--iterations', '--ai-model'):
        p.add_argument(flag)
    for flag in ('--costume', '--hero', '--skip-tier'):
        p.add_argument(flag, action='append', default=[])
    for flag in ('--rebuild', '--strict', '--keep-existing', '--disabled', '--no-cel', '--offline', '--no-heads', '--heads-only'):
        p.add_argument(flag, action='store_true')
    return p


def installs(args):
    port = Path(args.port) if args.port else None
    mua1 = Path(args.mua1) if args.mua1 else None
    mua2 = Path(args.mua2) if args.mua2 else None
    port_ok = bool(port and (port / 'Actors').is_dir())
    return {
        'port': dict(kind='port', path=str(port) if port else None, flavour='', found=port_ok,
                     problems=[] if port_ok else ['no Actors\\ in the port folder']),
        'mua1': dict(kind='mua1', path=str(mua1) if mua1 else None, flavour='2016-bin' if mua1 and mua1.is_dir() else '',
                     found=bool(mua1 and mua1.is_dir()), problems=[]),
        'mua2': dict(kind='mua2', path=str(mua2) if mua2 else None, flavour='pc-bin' if mua2 and mua2.is_dir() else '',
                     found=bool(mua2 and mua2.is_dir()), problems=[]),
    }


def available(inst, tier, tiers, offline_check=None, source=None):
    if tier not in tiers:
        return False, 'no recipe'
    if tier in ('mua1', 'mua2') and not inst[tier]['found']:
        return False, f'{tier} not installed'
    if tier == 'community' and offline_check and not offline_check(source or tiers[tier][0]):
        return False, f'{source or tiers[tier][0]} is not in the download cache (offline)'
    return True, {'mua2': 'mua2 pc-bin actor', 'mua1': 'mua1 2016-bin actor', 'xml2': 'XML2 actor in the port',
                  'community': "community skin (fetched on build from the author's link)", 'sharpen': 'port textures'}[tier]


def costumes_of(args):
    out = {}
    for item in args.costume:
        hero, _, spec = item.partition('=')
        tier, _, costume = spec.rpartition(':')
        out[hero] = (tier or None, costume)
    return out


def archive_cache(args, hero, costume):
    """Where a "downloaded" community archive is remembered (<work>\\community-cache, like the tool's)."""
    return Path(args.work or '.') / 'community-cache' / 'archives' / f'{hero}-{costume.replace(" ", "_")}.fake'


def cmd_scan(args):
    inst = installs(args)
    heroes = {}
    for key, (name, skin, tiers) in HEROES.items():
        entry = {}
        for tier in ('mua2', 'mua1', 'xml2', 'community', 'sharpen'):
            ok, why = available(inst, tier, tiers)
            costumes = tiers.get(tier, [])
            item = dict(available=ok, reason=why, source=costumes[0] if costumes else None, status='numeric', note='fake',
                        costumes=costumes)
            if costumes:
                item['author'] = AUTHOR if tier == 'community' else ''
                item['costume_info'] = costume_info(args, key, tier, costumes)
            if tier == 'community' and costumes:
                item['cached'] = {c: archive_cache(args, key, c).is_file() for c in costumes}
            entry[tier] = item
        heroes[key] = dict(name=name, skin=skin, tiers=entry)
    emit('result', installs=inst, steam_libraries=[], helpers=dict(python=sys.executable, python_modules={}, sampler=None,
                                                                    extractor='fake'), heroes=heroes)
    return 0


def make_plan(args, inst):
    mode = args.mode or 'community'
    chosen = costumes_of(args)
    rows = []
    cached = None
    if args.offline:
        cached = {}

        def is_cached(hero):
            return lambda costume: archive_cache(args, hero, costume).is_file()
    for key, (name, skin, tiers) in HEROES.items():
        if args.hero and key not in args.hero:
            continue
        row = dict(hero=key, name=name, skin=skin, tier='stock', source='', status='numeric', accepted=False, reason='', fallbacks=[], skipped=[])
        order = ORDER[mode]
        for i, tier in enumerate(order):
            want_tier, want = chosen.get(key, (None, None))
            source = tiers[tier][0] if tier in tiers else None
            if want and tier in tiers and (want_tier in (None, tier)) and want in tiers[tier]:
                source = want
            ok, why = available(inst, tier, tiers, is_cached(key) if cached is not None else None, source)
            if not ok:
                row['skipped'].append(dict(tier=tier, reason=why))
                continue
            row.update(tier=tier, source=source, reason=f'{why} {source}', fallbacks=[t for t in order[i + 1:] if t in tiers],
                       accepted=key == 'wolverine' and tier == 'mua2')
            break
        else:
            offline_skip = next((s['reason'] for s in row['skipped'] if s['reason'].endswith('(offline)')), '')
            row['reason'] = offline_skip or ('none of the ' + mode + ' sources has this hero' if mode != 'community' else 'no community skin for this hero')
        rows.append(row)
    return mode, rows


def cmd_plan(args):
    inst = installs(args)
    mode, rows = make_plan(args, inst)
    emit('result', mode=mode, pack=PACKS[mode], rows=rows)
    return 0


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def file_hashes(folder):
    folder = Path(folder)
    out = {}
    for p in sorted(folder.rglob('*')):
        if p.is_file() and p.name != MARKER:
            out[p.relative_to(folder).as_posix()] = dict(sha256=sha256(p), bytes=p.stat().st_size)
    return out


def read_marker(folder):
    try:
        data = json.loads((Path(folder) / MARKER).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return data if data.get('generator') == GENERATOR else None


def owned(mods):
    if not mods.is_dir():
        return []
    return sorted(p.name for p in mods.iterdir() if p.is_dir() and not p.name.startswith('.') and read_marker(p))


def group_of(folder):
    marker = read_marker(folder)
    return None if marker is None else marker.get('group', Path(folder).name)


# load-order.txt: lines kept byte for byte; only the named entries change.
def read_order(mods):
    p = mods / 'load-order.txt'
    return p.read_bytes().decode('utf-8') if p.is_file() else ''


def set_entry(text, name, enabled):
    lines = text.splitlines(keepends=True)
    out, found = [], False
    for line in lines:
        bare = line.rstrip('\r\n')
        if len(bare) > 1 and bare[0] in '+-' and bare[1:].casefold() == name.casefold():
            ending = line[len(bare):]
            out.append(('+' if enabled else '-') + bare[1:] + ending)
            found = True
        else:
            out.append(line)
    if not found:
        if out and not out[-1].endswith('\n'):
            out[-1] += '\r\n'
        out.append(('+' if enabled else '-') + name + '\r\n')
    return ''.join(out)


def remove_entry(text, name):
    lines = text.splitlines(keepends=True)
    return ''.join(line for line in lines if not (len(line.rstrip('\r\n')) > 1 and line[0] in '+-' and
                                                    line.rstrip('\r\n')[1:].casefold() == name.casefold()))


def write_order(mods, text):
    (mods / 'load-order.txt').write_bytes(text.encode('utf-8'))


def port_build(args, skin):
    """What the marker records of the port a folder was made for (LAUNCHER-API.md verify / port_build)."""
    port = Path(args.port)
    files = {}
    for rel in (f'Actors/{skin}.IGB', 'libIGSg.dll'):
        p = port / rel
        if p.is_file():
            files[rel] = sha256(p)
    fingerprint = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    return dict(fingerprint=fingerprint, builder='fake', files=files)


def migrate(args, mods, group):
    """0.2.x folders of this group named <Tier>-<Hero> become the group-qualified name (load-order line renamed
    in place, same sign and position)."""
    renamed = []
    for old in owned(mods):
        marker = read_marker(mods / old)
        if (marker.get('group') or '').casefold() != group.casefold():
            continue
        characters = marker.get('characters') or {}
        if len(characters) != 1:
            continue
        hero, info = next(iter(characters.items()))
        if hero not in HEROES or info.get('tier') not in FOLDER_PREFIX:
            continue
        new = folder_name(group, info['tier'], hero)
        if new == old or (mods / new).exists():
            continue
        os.replace(mods / old, mods / new)
        marker['pack'] = new
        (mods / new / MARKER).write_text(json.dumps(marker, indent=1), encoding='utf-8')
        text = read_order(mods)
        lines = text.splitlines(keepends=True)
        for i, line in enumerate(lines):
            bare = line.rstrip('\r\n')
            if len(bare) > 1 and bare[0] in '+-' and bare[1:].casefold() == old.casefold():
                lines[i] = bare[0] + new + line[len(bare):]
        write_order(mods, ''.join(lines))
        emit('stage', stage='publish', message=f'renamed {old} to {new} (group-qualified folder names)')
        renamed.append((old, new))
    return renamed


def cmd_build(args):
    inst = installs(args)
    if not inst['port']['found']:
        return fail('; '.join(inst['port']['problems']), 3)
    mode, rows = make_plan(args, inst)
    emit('plan', mode=mode, rows=rows)
    work = port_work(args)
    work.mkdir(parents=True, exist_ok=True)
    emit('workspace', path=str(work))
    forced = knob('BUILD_EXIT')
    if forced:
        code = int(forced)
        messages = {20: f"download refused: {AUTHOR}'s archive did not match its SHA-256", 3: 'the x86 sampler is missing (sample_enbaya.exe)'}
        return fail(messages.get(code, f'forced exit {code}'), code)

    delay = float(knob('DELAY', '0.6'))
    failing = {h.strip() for h in knob('FAIL').split(',') if h.strip()}
    group = args.pack or PACKS[mode]
    mods = Path(args.game or args.port) / 'mods'
    mods.mkdir(parents=True, exist_ok=True)
    for stale in mods.glob('.legends-models-*'):
        shutil.rmtree(stale, ignore_errors=True)
    migrate(args, mods, group)

    todo = [r for r in rows if r['tier'] != 'stock']
    characters, refused, stock = {}, {}, {r['hero']: r['reason'] for r in rows if r['tier'] == 'stock'}
    published = []
    for i, row in enumerate(todo):
        hero, tier, source = row['hero'], row['tier'], row['source']
        name, skin, tiers = HEROES[hero]
        attempts = []
        order = [tier] + [t for t in row['fallbacks']]
        passed_tier = None
        for attempt in order:
            src = source if attempt == tier else tiers[attempt][0]
            emit('stage', stage='convert', message=f'{name}: {attempt} {src}', hero=hero, tier=attempt, source=src)
            if attempt == 'community' and not archive_cache(args, hero, src).is_file():
                data = f'fake archive {hero} {src}'.encode()
                archive_cache(args, hero, src).parent.mkdir(parents=True, exist_ok=True)
                archive_cache(args, hero, src).write_bytes(data)
                emit('download', archive=f'{name.replace(" ", "")}-{src.replace(" ", "")}.rar', source='mirror' if args.mirror else 'author',
                     bytes=1048576 + 4096 * i, sha256=hashlib.sha256(data).hexdigest(), character=hero, costume=src)
                preview = preview_path(args, hero, src)
                preview.parent.mkdir(parents=True, exist_ok=True)
                shade = int(hashlib.sha256(f'{hero}{src}'.encode()).hexdigest()[:6], 16)
                preview.write_bytes(png(64, 64, ((shade >> 16) & 255, (shade >> 8) & 255, shade & 255)))
            emit('engine', engine=attempt, script='fake', log=str(work / f'{hero}-{attempt}.log'))
            time.sleep(delay)
            if hero in failing:
                failures = ['seam opens at the left glove (separation 0.8)', 'edge stretch 4.6x > stock 3.9x']
                emit('gate', hero=hero, tier=attempt, passed=False, failures=failures)
                attempts.append(dict(tier=attempt, failures=failures))
                continue
            emit('gate', hero=hero, tier=attempt, passed=True, owner_accepted=row.get('accepted', False))
            passed_tier = (attempt, src)
            break
        emit('progress', done=i + 1, total=len(todo), message=f'{name} done', hero=hero)
        if not passed_tier:
            refused[hero] = dict(attempts=attempts)
            continue
        attempt, src = passed_tier
        folder_name_ = folder_name(group, attempt, hero)
        staging = mods / f'.legends-models-staging-{folder_name_}-{os.getpid()}'
        (staging / 'Actors').mkdir(parents=True, exist_ok=True)
        (staging / 'Actors' / f'{skin}.IGB').write_bytes(f'FAKE legends-models output for {hero} ({attempt} {src}) - not a model\n'.encode())
        (staging / 'mod.json').write_text(json.dumps(dict(name=f'{name} ({FOLDER_PREFIX[attempt]})', author='legends-models (test stand-in)',
                                                          description='Test stand-in output: no model.')), encoding='utf-8')
        (staging / 'readme.txt').write_text('Generated on this PC by the legends-models test stand-in.\n', encoding='utf-8')
        if attempt == 'community':
            (staging / 'CREDITS.md').write_text(
                f'# Credits\n\nCommunity skins: {AUTHOR}.\nSource and permission: the author\'s MarvelMods thread.\n\n'
                f'## {name}\n\n- {src}: {AUTHOR}\n', encoding='utf-8')
        info = dict(tier=attempt, source=src, file=f'Actors/{skin}.IGB', folder=folder_name_, sha256=sha256(staging / 'Actors' / f'{skin}.IGB'),
                    gate='passed', owner_accepted=row.get('accepted', False), notes=[], fallback_from=[a['tier'] for a in attempts])
        marker = dict(generator=GENERATOR, version='0.3.0-fake', pack=folder_name_, mode=mode, group=group, characters={hero: info},
                      files=file_hashes(staging), port=str(args.port), port_build=port_build(args, skin))
        (staging / MARKER).write_text(json.dumps(marker, indent=1), encoding='utf-8')
        final = mods / folder_name_
        if final.exists():
            existing = read_marker(final)
            if existing is None or (existing.get('group') or '').casefold() != group.casefold():
                shutil.rmtree(staging, ignore_errors=True)
                return fail(f'{final} is not a {group} folder of legends-models; refusing to replace it', 40)
            shutil.rmtree(final)
        # this group's older folder for the hero (another tier) goes
        for other in owned(mods):
            m = read_marker(mods / other)
            if other != folder_name_ and m.get('group') == group and hero in m.get('characters', {}):
                shutil.rmtree(mods / other)
                write_order(mods, remove_entry(read_order(mods), other))
        os.replace(staging, final)
        characters[hero] = info
        published.append(folder_name_)

    if published:
        emit('stage', stage='publish', message=f'Writing {len(published)} folders')
        text = read_order(mods)
        for other in owned(mods):
            if (group_of(mods / other) or '').casefold() != group.casefold():
                text = set_entry(text, other, False)
        for folder in published:
            text = set_entry(text, folder, True)
        write_order(mods, text)
    result = dict(pack=group, layout='per-hero', written=bool(published), folders=published, enabled=bool(published),
                  files=sum(len(file_hashes(mods / f)) for f in published), characters=characters, refused=refused, stock=stock)
    emit('result', **result)
    if not published:
        return 11
    return 10 if (refused or stock) else 0


def members(mods, name):
    return [f for f in owned(mods) if f.casefold() == name.casefold() or (group_of(mods / f) or '').casefold() == name.casefold()]


def cmd_verify(args):
    mods = Path(args.game or args.port) / 'mods'
    folders = members(mods, args.pack)
    missing, changed, extra, files = [], [], [], 0
    for folder in folders:
        marker = read_marker(mods / folder)
        actual = file_hashes(mods / folder)
        expected = {k: v['sha256'] for k, v in marker.get('files', {}).items()}
        files += len(expected)
        missing += [f'{folder}/{k}' for k in expected if k not in actual]
        changed += [f'{folder}/{k}' for k, v in expected.items() if k in actual and actual[k]['sha256'] != v]
        extra += [f'{folder}/{k}' for k in actual if k not in expected]
    text = read_order(mods)
    states = [line[0] == '+' for line in text.splitlines() if len(line) > 1 and line[0] in '+-' and line[1:] in folders]
    load_order = 'not listed' if not states else ('enabled' if all(states) else 'disabled')
    ok = bool(folders) and not missing and not changed
    stale_folders, port_changed, unknown = [], [], []
    for folder in folders:
        recorded = (read_marker(mods / folder) or {}).get('port_build')
        if not recorded:
            unknown.append(folder)
            continue
        changed_files = []
        for rel, digest in (recorded.get('files') or {}).items():
            p = Path(args.port) / rel
            if not p.is_file() or sha256(p) != digest:
                changed_files.append(rel)
        if changed_files:
            stale_folders.append(folder)
            port_changed += [f'{folder}: {rel}' for rel in changed_files]
    emit('result', pack=args.pack, ok=ok, files=files, folders=folders, missing=missing, extra=extra, changed=changed, load_order=load_order,
         stale=bool(stale_folders), stale_folders=stale_folders, port_changed=port_changed, port_build_unknown=unknown)
    if not ok:
        return 30
    return 31 if stale_folders else 0


def cmd_remove(args):
    mods = Path(args.game or args.port) / 'mods'
    target = mods / args.pack
    if target.exists() and read_marker(target) is None:
        return fail(f'{target} is not a legends-models pack; refusing to delete it', 40)
    folders = members(mods, args.pack)
    text = read_order(mods)
    had = any(len(line) > 1 and line[0] in '+-' and line[1:] in folders + [args.pack] for line in text.splitlines())
    for folder in folders:
        shutil.rmtree(mods / folder)
        text = remove_entry(text, folder)
    text = remove_entry(text, args.pack)
    if mods.is_dir():
        write_order(mods, text)
    emit('result', pack=args.pack, folder_removed=bool(folders), load_order_entry_removed=had, folders=folders)
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    log = os.environ.get('FAKE_LM_LOG')
    if log:
        with open(log, 'a', encoding='utf-8') as f:
            f.write(json.dumps(argv) + '\n')
    try:
        args = parser().parse_args(argv)
    except SystemExit:
        emit('error', message='invalid arguments', code=2)
        return 2
    if args.work:
        try:
            KNOBS.update(json.loads((Path(args.work) / 'fake-knobs.json').read_text(encoding='utf-8')))
        except (OSError, ValueError):
            pass
    if not args.json:
        print('the fake legends-models speaks --json only', file=sys.stderr)
        return 2
    if args.command in ('plan', 'build') and args.mode not in PACKS:
        return fail(f'unknown mode {args.mode}', 2)
    print(f'fake legends-models {args.command}', file=sys.stderr, flush=True)
    return {'scan': cmd_scan, 'plan': cmd_plan, 'build': cmd_build, 'verify': cmd_verify, 'remove': cmd_remove}.get(
        args.command, lambda a: fail('--offline forbids downloading' if a.offline else 'fetch is not faked', 20 if a.offline else 2))(args)


if __name__ == '__main__':
    sys.exit(main())
