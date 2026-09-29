"""A fake xml1-builder for the launcher's tests: the CLI and the event schema of the real builder
(Legends Classic's xml1builder, BUILDER_DESIGN.md section 2), acted out on tiny test folders, so
the launcher's X-Men Legends entry can be built and tested without game data and without the real
pipeline.

    python fake_xml1_builder.py --version
    python fake_xml1_builder.py info    [--iso PATH] [--xml2 DIR] [--out DIR] [--cache DIR]
    python fake_xml1_builder.py build   [--iso PATH] --xml2 DIR --out DIR [--movies | --no-movies] [--cache DIR]
                                        [--keep-cache | --drop-cache] [--link-base] [--jobs N] [--no-ini]
                                        [--allow-unknown-exe]
    python fake_xml1_builder.py verify  --out DIR [--iso PATH] [--xml2 DIR] [--deep]
    python fake_xml1_builder.py clean   [--out DIR] [--mods] [--cache DIR] [--dry-run]
    global: [--events jsonl] [--log FILE] [--quiet]

The launcher runs it as xml1-builder.exe: `make_package()` lays out a PyInstaller-style folder
(xml1-builder.exe = tools/dev/native/builder_shim.c, _internal/xml1-builder.py = this file,
_internal/python.txt, _internal/fake-builder.json with the version) and zips it with a
xml1-builder.json manifest, as the real release does (section 4.5).

What is real here - the real builder's rules, so a test passes against either:
- arguments, exit codes (2.2), the JSON-lines events on stdout with human text on stderr (2.3),
  cancel by a `cancel` line or EOF on stdin (2.5), the locks (<out>/_build/lock, <cache>/lock),
  building.json and the stamp written last (2.6, 2.8), the state machine (2.7), the rotated log (2.4);
- the disc images: `make_fake_iso()` writes real, tiny images - an XDVDFS file system with a real XBE
  certificate in default.xbe, an ISO 9660 image with a PS2 SYSTEM.CNF, the GameCube / CSO magics - and
  identify_iso() reads them by the real rules: the partition offsets, the directory tree (a file beyond
  the end of the image is E_ISO_READ), default.xbe's title ID (another title is E_ISO_WRONG_GAME with its
  title), the required files (E_ISO_INCOMPLETE), the zip; disc_id = xbe md5 + the zip's digest;
- the destination: an empty folder, one the builder made, or one that holds only what the launcher and
  the player own (dinput.dll, xml2-fix.*, mods/) - which `info` still calls "foreign", as the real one does;
- the cache layout (<cache>/<disc_id>/disc/stage.json, prepared/<stage>-v1-<key>/stage.json, disc.json),
  and `build` without --iso when the cache holds the disc (the one of the folder's stamp / building.json);
- _build/manifest.json (every file: size, sha1, kind base/built), `verify` against it with the real
  groups (missing, changed, unreadable, extra, xml2_not_retail), counts and cause hints, and
  _build/verify-report.json written by every build and verify; `finish` copies again a damaged copy;
- warnings W_ISO_UNKNOWN_DUMP, W_XML2_MODIFIED (the stand-in XML2 against its reference list),
  W_EXTRA_FILES, W_LINK_BASE, W_PIPELINE (a count per stage);
- keeping dinput.dll / xml2-fix.* / mods in <out> (F3), merging the port's ini keys without touching
  the launcher's (3.5), and clean deleting only what the build made.

What is fake: the work. The "XML2 install" is any small folder with XMen2.exe, Data/herostat.engb and
Sounds/eng; the build copies it into <out> and writes a few made-up content files, nothing in it is
game data. The fake refuses folders or images larger than 64 MB, so it never works on a real install.
A test image's z/assetsfb.zip carries fake.json, which steers a run: {"speed": seconds multiplier,
"fail_stage": id, "crash_stage": id, "io_error_stage": id, "need_bytes": n, "cache_need_bytes": n,
"ignore_cancel": true, "warnings": n, "validate_errors": n} - the real builder has none of these
(fail_stage and ignore_cancel only work here: xml1_cdp.py --real finds other ways, or skips them).
"""
import argparse
import datetime
import fnmatch
import hashlib
import io
import json
import os
import pathlib
import shutil
import struct
import sys
import threading
import time
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
START = time.monotonic()
SCHEMA = 1

SECTOR = 2048
XDVDFS_MAGIC = b"MICROSOFT*XBOX*MEDIA"
VOLUME_OFFSET = 0x10000
PARTITIONS = ((0x18300000, "redump-xgd1"), (0x0FD90000, "redump-xgd2"), (0x02080000, "redump-xgd3"), (0, "xiso"))
XML1_TITLE_ID = 0x4156001E
REFUSE_BYTES = 64 * 1024 * 1024
OWNED_ROOT = ("dinput.dll", "mods", "xml2-fix.*")      # the launcher's and the player's (= the real builder)
META_ROOT = ("_build", "_tour.json", ".codegpt-game.json")
PROFILE = {"frontend": "xml1", "forced_teams": "seat", "newgame": "keepteam", "xp_curve": "xml1", "tiles": "used",
           "hero_roster": "21", "hero_icons": "xml1", "hero_bleed": "on", "blackbird": "menu", "npc_scaling": "off"}
PORT_INI = {"Game": {"NewGameTeam": "wolverine", "ResetUnlocks": "0", "SaveFolder": "X-Men Legends", "ForcedTeams": "1",
                     "PostgameScript": "x1/menus/postgame", "MainMenuItems": "button1,button2,button3,button4,button5,button6,button7",
                     "XPCurve": "xml1"},
            "Limits": {"ActorSlots": "127", "ResourceNames": "1024"}}
PREPARED_NAMES = {"extract": "disc", "tables": "tables", "scripts": "scripts", "sound": "sound", "music": "music"}

# (id, title, weight, cache stage, unit, count): the order of a build, weights as measured seconds (section 1.5).
STAGES = [
    ("probe", "Checking your files", 1, False, "checks", 4),
    ("extract", "Reading the disc", 6, True, "files", 1888),
    ("tables", "Preparing tables", 1, True, "tables", 6),
    ("scripts", "Rewriting scripts", 1, True, "scripts", 1536),
    ("sound", "Converting sound banks", 4, True, "banks", 155),
    ("music", "Fixing the music", 8, True, "banks", 61),
    ("sync", "Copying X-Men Legends II", 5, False, "files", 0),
    ("content", "Building the game", 10, False, "files", 8065),
    ("sweep", "Removing old files", 1, False, "files", 0),
    ("validate", "Checking the build", 3, False, "checks", 12),
    ("finish", "Verifying the files", 1, False, "files", 3),
]
CONTENT_FILES = {"data/xml1/herostat_x1.txt": "heroes", "data/xml1/zoneinfo_x1.txt": "zones",
                 "scripts/x1/menus/postgame.txt": "scripts", "ui/menus/x1_main.txt": "frontend",
                 "packages/generated/x1/nyc1_1.txt": "zones", "sounds/eng/x1_music.txt": "media"}
MOVIE_FILES = {"movies/x1_intro.txt": "media", "movies/x1_outro.txt": "media"}

CAUSES = {  # the real builder's cause hints (xml1builder/manifest.py)
    "missing": "Files missing: deleted after the build, or quarantined by an antivirus program.",
    "changed": "Files changed after the build: another program or a mod edited them (or the disk damaged them).",
    "unreadable": "Files that could not be read: in use by another program, or blocked by an antivirus program.",
    "extra": "Files the build did not make: added by another program, a mod copied into the game folders, or left "
             "over from an interrupted build (a rebuild removes them).",
    "xml2_changed": "X-Men Legends II's files differ from the ones this port was built from: the XML2 install was "
                    "modified, updated or repaired since.",
    "xml2_not_retail": "X-Men Legends II's files differed from a retail install when this port was built: the XML2 "
                       "install was modified (a mod or a patch installed into it).",
    "disc_unknown": "The disc image doesn't match a known good dump (a different release, or a modified image).",
    "disc_changed": "The disc image is not the one this port was built from.",
}
REPAIRS = ("missing", "changed", "unreadable")

CURRENT = {"stage": "probe"}


class Cancelled(Exception):
    pass


class Failure(Exception):
    def __init__(self, exit_code, code, msg, hint="", detail=None, stage=None):
        super().__init__(msg)
        self.exit_code, self.code, self.msg, self.hint, self.detail, self.stage = exit_code, code, msg, hint, detail or {}, stage


# ---------------------------------------------------------------------------------------------
# disc images: real XDVDFS / XBE / ISO 9660 bytes (the rules of the builder's unit-test fixtures)

def _entry_len(name):
    return (14 + len(name.encode("latin-1")) + 3) & ~3


def xdvdfs(files):
    """The bytes of an XDVDFS partition (an XISO) holding files {path: bytes}: the volume descriptor at
    0x10000 with the magic at both ends, directory tables whose entries chain through `right`, and
    every file as one contiguous extent after the tables."""
    root = {}
    for path, data in files.items():
        parts = path.strip("/").split("/")
        node = root
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = bytes(data)

    layouts, order = {}, []

    def plan(node, path):
        offsets, pos = [], 0
        names = sorted(node, key=str.upper)
        for name in names:
            length = _entry_len(name)
            if pos // SECTOR != (pos + length - 1) // SECTOR:
                pos = (pos // SECTOR + 1) * SECTOR
            offsets.append((pos, name))
            pos += length
        layouts[path] = (offsets, ((pos + SECTOR - 1) // SECTOR) * SECTOR if pos else 0)
        order.append(path)
        for name, child in node.items():
            if isinstance(child, dict):
                plan(child, f"{path}/{name}" if path else name)

    plan(root, "")
    sector = 33
    where = {}
    for path in order:
        size = layouts[path][1]
        where[path] = (sector if size else 0, size)
        sector += size // SECTOR
    data_at = {}

    def allocate(node, path):
        nonlocal sector
        for name, child in node.items():
            child_path = f"{path}/{name}" if path else name
            if isinstance(child, dict):
                allocate(child, child_path)
            else:
                data_at[child_path] = (sector if child else 0, len(child), child)
                sector += (len(child) + SECTOR - 1) // SECTOR

    allocate(root, "")
    image = bytearray(sector * SECTOR)
    volume = bytearray(SECTOR)
    volume[0:20] = XDVDFS_MAGIC
    struct.pack_into("<II", volume, 20, *where[""])
    volume[0x7EC:0x7EC + 20] = XDVDFS_MAGIC
    image[32 * SECTOR:33 * SECTOR] = volume

    def fill(node, path):
        offsets, size = layouts[path]
        if not size:
            return
        table = bytearray(b"\xff" * size)
        names = [name for _, name in offsets]
        index = {name: offset for offset, name in offsets}
        for i, name in enumerate(names):
            child = node[name]
            child_path = f"{path}/{name}" if path else name
            first, length = where[child_path] if isinstance(child, dict) else data_at[child_path][:2]
            right = index[names[i + 1]] // 4 if i + 1 < len(names) else 0
            raw = name.encode("latin-1")
            entry = struct.pack("<HHIIBB", 0, right, first, length, 0x10 if isinstance(child, dict) else 0x20, len(raw)) + raw
            entry = entry.ljust(_entry_len(name), b"\0")
            table[index[name]:index[name] + len(entry)] = entry
            if isinstance(child, dict):
                fill(child, child_path)
        start = where[path][0] * SECTOR
        image[start:start + size] = table

    fill(root, "")
    for first, length, data in data_at.values():
        if length:
            image[first * SECTOR:first * SECTOR + length] = data
    return bytes(image)


def xbe(title_id=XML1_TITLE_ID, title="X-Men Legends", version=1, region=7):
    """A minimal default.xbe: the XBEH header and a certificate with the title ID and name."""
    base, cert_offset = 0x10000, 0x180
    data = bytearray(0x400)
    data[0:4] = b"XBEH"
    struct.pack_into("<I", data, 0x104, base)
    struct.pack_into("<II", data, 0x114, 1092605368, base + cert_offset)
    cert = bytearray(0x1D0)
    struct.pack_into("<I", cert, 0x00, 0x1D0)
    struct.pack_into("<I", cert, 0x08, title_id)
    name = title.encode("utf-16-le")[:80]
    cert[0x0C:0x0C + len(name)] = name
    struct.pack_into("<5I", cert, 0x9C, 0x202, region, 3, 0, version)
    data[cert_offset:cert_offset + len(cert)] = cert[:0x400 - cert_offset]
    return bytes(data)


def iso9660(files):
    """An ISO 9660 image with files {NAME: bytes} in its root directory (a PS2 / PC disc stand-in)."""
    names = sorted(files)
    root_lba, first_file = 18, 19
    image = bytearray((first_file + sum((len(files[n]) + SECTOR - 1) // SECTOR or 1 for n in names)) * SECTOR)

    def record(lba, size, flags, name):
        length = 33 + len(name) + (1 - len(name) % 2)
        rec = bytearray(length)
        rec[0] = length
        struct.pack_into("<I", rec, 2, lba)
        struct.pack_into(">I", rec, 6, lba)
        struct.pack_into("<I", rec, 10, size)
        struct.pack_into(">I", rec, 14, size)
        rec[25] = flags
        rec[32] = len(name)
        rec[33:33 + len(name)] = name
        return bytes(rec)

    pvd = bytearray(SECTOR)
    pvd[0], pvd[1:6], pvd[6] = 1, b"CD001", 1
    pvd[156:156 + 34] = record(root_lba, SECTOR, 2, b"\0")
    image[16 * SECTOR:17 * SECTOR] = pvd
    image[17 * SECTOR:17 * SECTOR + 7] = b"\xffCD001\x01"
    table = bytearray(record(root_lba, SECTOR, 2, b"\0") + record(root_lba, SECTOR, 2, b"\1"))
    lba = first_file
    for name in names:
        table += record(lba, len(files[name]), 0, f"{name};1".encode("ascii"))
        image[lba * SECTOR:lba * SECTOR + len(files[name])] = files[name]
        lba += (len(files[name]) + SECTOR - 1) // SECTOR or 1
    image[root_lba * SECTOR:root_lba * SECTOR + len(table)] = table
    return bytes(image)


def _zip_bytes(members):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(zipfile.ZipInfo(name, date_time=(2004, 9, 21, 0, 0, 0)), data)
    return buffer.getvalue()


# The fake's own "known dumps": the real X-Men Legends (World) dump and the test disc below.
TEST_XBE_MD5 = hashlib.md5(xbe()).hexdigest()
KNOWN_XBE_MD5 = {"1e1a766ae4dc9f5f0151aa4ce029f362": "xml1-world-v1", TEST_XBE_MD5: "fake-test-disc"}


# ---------------------------------------------------------------------------------------------
# test fixtures (used by tools/dev/xml1_cdp.py)

def make_fake_iso(path, *, kind="xiso", title_id=XML1_TITLE_ID, title="X-Men Legends", incomplete=False,
                  truncated=False, fake=None):
    """Writes a tiny, real test disc image. kind: xiso (Xbox: an XDVDFS whose default.xbe carries
    title_id / title), ps2 (ISO 9660 with a PS2 SYSTEM.CNF), pc (plain ISO 9660), gamecube, cso.
    incomplete leaves z/assetsfb.zip out; truncated cuts the image inside its last file. `fake`
    (the knobs of the fake builder) rides in the zip as fake.json - the real builder ignores it."""
    path = pathlib.Path(path)
    if isinstance(title_id, str):
        title_id = int(title_id, 16)
    if kind == "xiso":
        members = {"data/colors.xml": b"<colors/>", "scripts/menus/start.py": b"print\r\n",
                   "fake.json": json.dumps(fake or {}, sort_keys=True).encode()}
        files = {"default.xbe": xbe(title_id, title), "z/assetsfb.zip": _zip_bytes(members),
                 "sounds/zsds/a/c/aco_m.zsm": b"ZSNDXBOX" + bytes(56), "movies/ntsc/i/1/i101.sfd": bytes(4096),
                 "OptionsImage.xpr": b"XPR0"}
        if incomplete:
            del files["z/assetsfb.zip"]
        data = xdvdfs(files)
        if truncated:
            data = data[:len(data) - 3 * SECTOR]  # the last file (the movie) now ends past the image
    elif kind == "ps2":
        data = iso9660({"SYSTEM.CNF": b"BOOT2 = cdrom0:\\SLUS_200.00;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n"})
    elif kind == "pc":
        data = iso9660({"README.TXT": b"A PC disc.\r\n"})
    elif kind == "gamecube":
        data = bytearray(0x440)
        data[0:6] = b"GXLE52"
        struct.pack_into(">I", data, 0x1C, 0xC2339F3D)
    elif kind == "cso":
        data = b"CISO" + bytes(0x800)
    else:
        raise ValueError(kind)
    path.write_bytes(bytes(data))
    return path


# The stand-in XML2 install: its files and sizes are its "retail reference" (XMen2.exe: any size), so
# a file added to it (a mod installed into XML2) reads as W_XML2_MODIFIED, as with a real install.
FAKE_XML2_FILES = {"Data/herostat.engb": b"stand-in", "Sounds/eng/shared.zss": b"stand-in" * 64,
                   "build.ini": b"Language = ENG\r\n"}


def make_fake_xml2(folder, exe_source=None):
    """A small stand-in for an X-Men Legends II install (never a real one)."""
    folder = pathlib.Path(folder)
    for rel, data in FAKE_XML2_FILES.items():
        target = folder / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    if exe_source:
        shutil.copy2(exe_source, folder / "XMen2.exe")
    else:
        (folder / "XMen2.exe").write_bytes(b"MZ placeholder - not a real game")
    return folder


def make_package(folder, *, version="1.0.0", content_version=3, shim, python=None, zip_name=None, base_url=""):
    """Lays out the fake builder like the real release (xml1-builder.exe + _internal/) in `folder`,
    zips it and writes xml1-builder.json next to the zip. Returns (zip path, manifest path)."""
    folder = pathlib.Path(folder)
    stage = folder / f"package-{version}"
    if stage.exists():
        shutil.rmtree(stage)
    (stage / "_internal").mkdir(parents=True)
    shutil.copy2(shim, stage / "xml1-builder.exe")
    shutil.copy2(__file__, stage / "_internal" / "xml1-builder.py")
    (stage / "_internal" / "python.txt").write_text(python or sys.executable, encoding="utf-8")
    (stage / "_internal" / "fake-builder.json").write_text(json.dumps(
        {"version": version, "content_version": content_version, "commit": "fake" + version.replace(".", "")}), encoding="utf-8")
    zip_name = zip_name or f"xml1-builder-{version}-win64.zip"
    archive = folder / zip_name
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(stage.rglob("*")):
            if file.is_file():
                z.write(file, file.relative_to(stage).as_posix())
    shutil.rmtree(stage)
    data = archive.read_bytes()
    manifest = {"version": version, "content_version": content_version, "zip": zip_name, "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "min_launcher": "0.0.0", "requires_xml2fix": ">=1.2.0"}
    if base_url:
        manifest["url"] = base_url.rstrip("/") + "/" + zip_name
    manifest_path = folder / "xml1-builder.json"
    manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return archive, manifest_path


# ---------------------------------------------------------------------------------------------
# events and logs

class Output:
    def __init__(self, jsonl, quiet, log_file=None):
        self.jsonl, self.quiet = jsonl, quiet
        self.log = None
        self.log_path = None
        self.pending_log = []
        self.last_progress = {}
        self.lock = threading.Lock()
        if log_file:
            self.open_log(pathlib.Path(log_file), rotate=False)

    def t(self):
        return int((time.monotonic() - START) * 1000)

    def event(self, ev, **fields):
        record = {"ev": ev, "t": self.t(), **fields}
        if self.jsonl:
            with self.lock:
                sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
                sys.stdout.flush()
        if ev not in ("progress",):
            self.write_log(json.dumps(record, ensure_ascii=False))

    def human(self, text):
        """Human text: stderr in jsonl mode, stdout otherwise; always the log."""
        if not self.quiet:
            stream = sys.stderr if self.jsonl else sys.stdout
            stream.write(text + "\n")
            stream.flush()
        self.write_log(text)

    def progress(self, stage, done, total, unit, overall, eta):
        now = time.monotonic()
        if done < total and now - self.last_progress.get(stage, 0) < 0.25:
            return  # ~4 per second per stage
        self.last_progress[stage] = now
        pct = round(100.0 * done / total, 1) if total else 100.0
        self.event("progress", stage=stage, done=done, total=total, unit=unit, pct=pct, overall=round(overall, 1),
                   eta_s=int(max(0, eta)))

    def open_log(self, path, rotate=True):
        path.parent.mkdir(parents=True, exist_ok=True)
        if rotate and path.exists():
            for index in (2, 1):
                older = path.with_name(f"builder.{index}.log")
                newer = path if index == 1 else path.with_name(f"builder.{index - 1}.log")
                if newer.exists():
                    os.replace(newer, older)
        if self.log:
            self.log.close()
        self.log = open(path, "a", encoding="utf-8")
        self.log_path = path
        for line in self.pending_log:
            self.log.write(line + "\n")
        self.pending_log = []

    def write_log(self, line):
        stamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"{stamp} {line}"
        if self.log:
            self.log.write(line + "\n")
            self.log.flush()
        else:
            self.pending_log.append(line)


def mask(path):
    text = str(path)
    profile = os.environ.get("USERPROFILE")
    return text.replace(profile, "%USERPROFILE%") if profile else text


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------------------------
# cancellation

class CancelFlag:
    def __init__(self, jsonl):
        self.event = threading.Event()
        self.ignore = False
        if jsonl:
            threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for line in sys.stdin:
                if line.strip() == "cancel":
                    self.event.set()
                    break
            else:
                self.event.set()  # EOF: the launcher went away
        except Exception:
            self.event.set()

    def check(self):
        if self.event.is_set() and not self.ignore:
            raise Cancelled()


# ---------------------------------------------------------------------------------------------
# the disc image (the real builder's rules: xml1build/prepare/image.py, disc.py, xbe.py)

def _read_at(fh, offset, count):
    fh.seek(offset)
    return fh.read(count)


def _not_xbox(msg, detected, hint="Choose a disc image made from your X-Men Legends Xbox disc."):
    return Failure(3, "E_ISO_NOT_XBOX", msg, hint, {"detected": detected})


def detect_image(fh, size):
    """(format, partition offset) of an Xbox image; Failure for anything else."""
    for offset, fmt in PARTITIONS:
        if offset + VOLUME_OFFSET + SECTOR > size:
            continue
        volume = _read_at(fh, offset + VOLUME_OFFSET, SECTOR)
        if volume[:20] == XDVDFS_MAGIC and volume[0x7EC:0x7EC + 20] == XDVDFS_MAGIC:
            return fmt, offset
    head = _read_at(fh, 0, 0x40)
    compressed = "Decompress it to a plain .iso with the tool that made it, then choose that file."
    if head[:4] == b"CCIM":
        raise Failure(3, "E_ISO_COMPRESSED", "This is a compressed CCI image.", compressed, {"detected": "cci"})
    if head[:4] in (b"CISO", b"ZISO"):
        raise Failure(3, "E_ISO_COMPRESSED", f"This is a compressed {head[:4].decode()} image.", compressed,
                      {"detected": head[:4].decode().lower()})
    for signature, kind in ((b"PK\x03\x04", "zip"), (b"7z\xbc\xaf\x27\x1c", "7z"), (b"Rar!\x1a\x07", "rar")):
        if head.startswith(signature):
            raise Failure(3, "E_ISO_COMPRESSED", f"This is a {kind} archive, not a disc image.",
                          "Extract the .iso from the archive first.", {"detected": kind})
    if len(head) >= 0x20 and struct.unpack_from(">I", head, 0x1C)[0] == 0xC2339F3D:
        raise _not_xbox("This is a GameCube disc image; the builder needs the Xbox version of X-Men Legends.", "gamecube")
    if len(head) >= 0x1C and struct.unpack_from(">I", head, 0x18)[0] == 0x5D1C9EA3:
        raise _not_xbox("This is a Wii disc image; the builder needs the Xbox version of X-Men Legends.", "wii")
    pvd = _read_at(fh, 0x8000, SECTOR) if size >= 0x8000 + SECTOR else b""
    if pvd[1:6] == b"CD001":
        cnf = _iso9660_root_file(fh, pvd, "SYSTEM.CNF")
        if cnf is not None and b"BOOT2" in cnf.upper():
            kind, what = "ps2", "a PlayStation 2 disc image"
        elif cnf is not None and b"BOOT" in cnf.upper():
            kind, what = "ps1", "a PlayStation disc image"
        else:
            kind, what = "iso9660", "an ISO 9660 image (a PC or other disc)"
        raise _not_xbox(f"This is {what}, not an Xbox disc image; the builder needs your X-Men Legends Xbox disc.", kind)
    raise _not_xbox("No Xbox file system (XDVDFS) found in this file.", "unknown", "Choose an Xbox disc image (.iso / .xiso).")


def _iso9660_root_file(fh, pvd, name):
    try:
        rec = pvd[156:156 + 34]
        lba, size = struct.unpack_from("<I", rec, 2)[0], struct.unpack_from("<I", rec, 10)[0]
        data = _read_at(fh, lba * SECTOR, min(size, 64 * SECTOR))
        pos = 0
        while pos < len(data):
            length = data[pos]
            if length == 0:
                pos = (pos // SECTOR + 1) * SECTOR
                continue
            name_length = data[pos + 32]
            found = data[pos + 33:pos + 33 + name_length].decode("latin-1").upper().split(";")[0]
            if found == name.upper():
                file_lba, file_size = struct.unpack_from("<I", data, pos + 2)[0], struct.unpack_from("<I", data, pos + 10)[0]
                return _read_at(fh, file_lba * SECTOR, min(file_size, 4096))
            pos += length
    except (struct.error, IndexError):
        return None
    return None


def read_xdvdfs(fh, size, partition):
    """{lower path: (path, sector, size, is_dir)} of the image's file system; E_ISO_READ when damaged or truncated."""
    volume = _read_at(fh, partition + VOLUME_OFFSET, SECTOR)
    root_sector, root_size = struct.unpack_from("<II", volume, 20)
    entries = {}

    def walk(sector, length, prefix, depth=0):
        if depth > 64:
            raise Failure(3, "E_ISO_READ", f"Directory nesting too deep under {prefix!r}.", "The image is damaged.", {})
        if length == 0:
            return
        start = partition + sector * SECTOR
        if start + length > size:
            raise Failure(3, "E_ISO_READ", f"Directory {prefix or '/'} lies beyond the end of the image.",
                          "The image is truncated - dump it again.", {"path": prefix or "/"})
        data = _read_at(fh, start, length)
        stack, seen = [0], set()
        while stack:
            offset = stack.pop()
            if offset in seen or offset + 14 > len(data):
                continue
            seen.add(offset)
            left, right, first, file_size, attributes, name_length = struct.unpack_from("<HHIIBB", data, offset)
            if left == 0xFFFF:
                continue
            name = data[offset + 14:offset + 14 + name_length].decode("latin-1")
            if left:
                stack.append(left * 4)
            if right:
                stack.append(right * 4)
            if not name or "/" in name or "\\" in name or name in (".", ".."):
                raise Failure(3, "E_ISO_READ", f"Bad directory entry {name!r} under {prefix or '/'}.", "The image is damaged.", {})
            path = f"{prefix}/{name}" if prefix else name
            is_dir = bool(attributes & 0x10)
            entries[path.lower()] = (path, first, file_size, is_dir)
            if is_dir:
                walk(first, file_size, path, depth + 1)
            elif partition + first * SECTOR + file_size > size:
                raise Failure(3, "E_ISO_READ", f"{path} lies beyond the end of the image.",
                              "The image is truncated - dump it again.", {"path": path})

    walk(root_sector, root_size, "")
    return entries


def parse_xbe(data):
    if len(data) < 0x178 or data[:4] != b"XBEH":
        raise Failure(3, "E_ISO_WRONG_GAME", "default.xbe is not an Xbox executable (no XBEH header).",
                      "The image is damaged or not an Xbox game.", {"xbe": "bad header"})
    base, = struct.unpack_from("<I", data, 0x104)
    cert_va, = struct.unpack_from("<I", data, 0x118)
    offset = cert_va - base
    if offset < 0 or offset + 0xB0 > len(data):
        raise Failure(3, "E_ISO_WRONG_GAME", "default.xbe: certificate outside the file.", "The image is damaged.", {"xbe": "bad certificate"})
    cert = data[offset:offset + 0xB0]
    title_id, = struct.unpack_from("<I", cert, 0x08)
    title = cert[0x0C:0x0C + 80].decode("utf-16-le", errors="replace").split("\0", 1)[0]
    return title_id, f"0x{title_id:08X}", title


def identify_iso(path):
    """-> info.iso (+ "fake": the knobs) for a test image, or raises Failure (the real builder's codes)."""
    path = pathlib.Path(path)
    if path.is_dir():
        raise Failure(3, "E_ISO_NOT_XBOX", "This is a folder, not a disc image.",
                      "Choose the disc image file (.iso) of your X-Men Legends Xbox disc.", {"detected": "folder", "path": mask(path)})
    if not path.is_file():
        raise Failure(3, "E_ISO_NOT_FOUND", f"No such file: {mask(path)}.", "", {"path": mask(path)})
    size = path.stat().st_size
    if size > REFUSE_BYTES:
        raise Failure(2, "E_USAGE", "The fake builder only reads its own test images.", "", {"size": size})
    with open(path, "rb") as fh:
        fmt, partition = detect_image(fh, size)
        entries = read_xdvdfs(fh, size, partition)

        def read(rel):
            _, sector, length, _ = entries[rel.lower()]
            return _read_at(fh, partition + sector * SECTOR, length)

        if "default.xbe" not in entries or entries["default.xbe"][3]:
            raise Failure(3, "E_ISO_WRONG_GAME", "No default.xbe on this disc: not an Xbox game disc.",
                          "Choose your X-Men Legends (Xbox) disc image.", {"xbe": "missing"})
        xbe_data = read("default.xbe")
        title_id, title_hex, title = parse_xbe(xbe_data)
        if title_id != XML1_TITLE_ID:
            raise Failure(3, "E_ISO_WRONG_GAME", f'This disc is "{title}" (title ID {title_hex}), not X-Men Legends (0x{XML1_TITLE_ID:08X}).',
                          "Choose your X-Men Legends (Xbox) disc image.", {"title_id": title_hex, "title": title})
        missing = []
        if "z/assetsfb.zip" not in entries or entries["z/assetsfb.zip"][2] == 0:
            missing.append("z/assetsfb.zip")
        if not any(k.startswith("sounds/zsds/") and not v[3] for k, v in entries.items()):
            missing.append("sounds/zsds/")
        if not any(k.startswith("movies/ntsc/") and k.endswith(".sfd") for k in entries):
            missing.append("movies/ntsc/*.sfd")
        if missing:
            raise Failure(3, "E_ISO_INCOMPLETE", f"The disc lacks {', '.join(missing)}.",
                          "This looks like a demo disc or an incomplete rip - dump the full disc again.", {"missing": missing})
        try:
            archive = zipfile.ZipFile(io.BytesIO(read("z/assetsfb.zip")))
        except zipfile.BadZipFile as error:
            raise Failure(3, "E_ISO_READ", f"z/assetsfb.zip is not a readable zip ({error}).", "The image is damaged.", {})
        members = [(i.filename, i.file_size, i.CRC, i.compress_type) for i in archive.infolist()]
        try:
            fake = json.loads(archive.read("fake.json"))
        except (KeyError, ValueError):
            fake = {}
    xbe_md5 = hashlib.md5(xbe_data).hexdigest()
    zip_digest = hashlib.sha1(json.dumps(members).encode()).hexdigest()
    listing = sorted((v[0], v[2], v[3]) for v in entries.values())
    digest = hashlib.sha1(json.dumps({"xbe_md5": xbe_md5, "zip_digest": zip_digest, "listing": listing}).encode()).hexdigest()
    known = KNOWN_XBE_MD5.get(xbe_md5, "")
    return {"path": mask(path), "format": fmt, "title": title, "title_id": title_hex, "xbe_md5": xbe_md5,
            "zip_digest": zip_digest, "known": bool(known), "dump": known, "movies": True, "digest": digest,
            "disc_id": xbe_md5[:12] + zip_digest[:8], "image_size": size, "fake": fake}


# ---------------------------------------------------------------------------------------------
# the XML2 install and the destination

def folder_bytes(folder):
    total = 0
    for root, _, files in os.walk(folder):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
            if total > REFUSE_BYTES:
                return total
    return total


def owned(rel):
    """a root entry the launcher / the player own, or build metadata: never part of the build's area."""
    top = str(rel).replace("\\", "/").split("/", 1)[0].lower()
    return top in META_ROOT or any(fnmatch.fnmatchcase(top, pattern) for pattern in OWNED_ROOT)


def is_proxy(rel):
    top = str(rel).replace("\\", "/").split("/", 1)[0].lower()
    return any(fnmatch.fnmatchcase(top, pattern) for pattern in OWNED_ROOT)


def area_files(out):
    """{lower rel: rel} of every file in the build's area of <out> (not the owned root entries, not _build)."""
    out = pathlib.Path(out)
    found = {}
    for dirpath, dirnames, filenames in os.walk(out):
        rel_dir = os.path.relpath(dirpath, out).replace(os.sep, "/")
        if rel_dir == ".":
            rel_dir = ""
            dirnames[:] = [d for d in dirnames if not owned(d)]
            filenames = [f for f in filenames if not owned(f)]
        for name in filenames:
            rel = f"{rel_dir}/{name}" if rel_dir else name
            found[rel.lower()] = rel
    return found


def base_listing(folder):
    """{rel: size} of the XML2 install's base files (everything but the launcher's files at the root)."""
    folder = pathlib.Path(folder)
    return {p.relative_to(folder).as_posix(): p.stat().st_size for p in folder.rglob("*")
            if p.is_file() and not is_proxy(p.relative_to(folder).as_posix())}


def check_xml2(folder):
    folder = pathlib.Path(folder)
    exe = folder / "XMen2.exe"
    if not folder.is_dir() or not exe.is_file():
        raise Failure(3, "E_XML2_NOT_FOUND", "X-Men Legends II was not found in this folder (no XMen2.exe).",
                      "Check X-Men Legends II's folder (in the launcher: its page, Settings).", {"path": mask(folder)})
    if folder_bytes(folder) > REFUSE_BYTES:
        raise Failure(2, "E_USAGE", "The fake builder only works on small test folders, never on a real install.", "", {})
    data_dir = next((c for c in folder.iterdir() if c.name.lower() == "data" and c.is_dir()), None)
    sounds = next((c for c in folder.iterdir() if c.name.lower() == "sounds" and c.is_dir()), None)
    english = data_dir is not None and any(c.name.lower() == "herostat.engb" for c in data_dir.iterdir()) and \
        sounds is not None and any(c.name.lower() == "eng" and c.is_dir() for c in sounds.iterdir())
    if not english:
        raise Failure(3, "E_XML2_LANGUAGE", "This X-Men Legends II install has no English data (Data/herostat.engb, Sounds/eng).",
                      "The port needs the English PC version of X-Men Legends II.", {"path": mask(folder)})
    listing = base_listing(folder)
    have = {rel.lower(): (rel, size) for rel, size in listing.items()}
    reference = {rel.lower(): len(data) for rel, data in FAKE_XML2_FILES.items()}
    modified = [f"changed: {have[low][0]}" for low, size in sorted(reference.items()) if low in have and have[low][1] != size]
    modified += [f"missing: {low}" for low in sorted(reference) if low not in have]
    modified += [f"added: {rel}" for low, (rel, _) in sorted(have.items()) if low not in reference and low != "xmen2.exe"]
    digest = hashlib.sha1(json.dumps(sorted((rel.lower(), size) for rel, size in listing.items())).encode()).hexdigest()
    return {"path": mask(folder), "exe_known": True, "exe_md5": hashlib.md5(exe.read_bytes()).hexdigest(), "exe": "fake-stand-in",
            "language": "ENG", "base_files": len(listing), "base_bytes": sum(listing.values()), "base_digest": digest,
            "reference": True, "modified": modified[:50], "modified_count": len(modified)}


def check_out(out, xml2=None, cache=None, iso=None):
    out = pathlib.Path(out).resolve()
    if len(out.parts) <= 1:
        raise Failure(2, "E_OUT_UNSAFE", "The game can't be built at the root of a drive.", "Choose a separate folder for X-Men Legends.", {"out": mask(out)})
    for other, label in ((xml2, "X-Men Legends II's folder"), (cache, "the build cache")):
        if other:
            other = pathlib.Path(other).resolve()
            if out == other or other in out.parents or out in other.parents:
                raise Failure(2, "E_OUT_UNSAFE", f"The game can't be built inside {label} (or around it).",
                              "Choose a separate folder for X-Men Legends.", {"out": mask(out), "conflict": mask(other)})
    if iso and (out == pathlib.Path(iso).resolve() or out in pathlib.Path(iso).resolve().parents):
        raise Failure(2, "E_OUT_UNSAFE", "The disc image is inside the destination folder.", "Choose a separate folder for X-Men Legends.",
                      {"out": mask(out), "conflict": mask(iso)})
    if out.exists() and not out.is_dir():
        raise Failure(2, "E_OUT_FOREIGN", "The destination is a file, not a folder.", "Choose an empty folder, or one the builder made before.", {"out": mask(out)})
    if out.exists() and not builder_folder(out) and area_files(out):
        raise Failure(2, "E_OUT_FOREIGN", "The destination folder already holds other files.",
                      "Choose an empty folder, or one the builder made before.", {"out": mask(out)})
    return out


def builder_folder(out):
    build = pathlib.Path(out) / "_build"
    return (build / "stamp.json").is_file() or (build / "building.json").is_file()


def read_json(path, default=None):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data, indent=1):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.tmp{os.getpid()}")
    temp.write_text(json.dumps(data, indent=indent), encoding="utf-8")
    os.replace(temp, path)


def out_state(out, version, iso=None, xml2=None):
    """-> (state, reasons, stamp) per section 2.7 (without 'damaged', which is verify's). As the real
    builder: a folder with files but no builder _build/ is "foreign", even one that holds only the
    launcher's files (which `build` accepts)."""
    out = pathlib.Path(out)
    if not out.exists() or (out.is_dir() and not any(out.iterdir())):
        return "absent", [], None
    if not out.is_dir():
        return "foreign", ["the destination is a file"], None
    if not builder_folder(out):
        return "foreign", ["files, but no build made by the builder (_build/stamp.json)"], None
    stamp = read_json(out / "_build" / "stamp.json")
    if (out / "_build" / "building.json").is_file() or not stamp:
        return "incomplete", ["a build was started and did not finish"], stamp
    reasons = []
    have = int((stamp.get("builder") or {}).get("content_version") or 0)
    if have < version["content_version"]:
        reasons.append(f"content version {have} < {version['content_version']}")
    stamped = dict(stamp.get("profile") or {})
    stamped.pop("movies", None)
    if stamped != PROFILE:
        reasons.append("the build profile changed")
    if iso and (stamp.get("inputs", {}).get("disc") or {}).get("digest") not in (None, iso.get("digest")):
        reasons.append("a different disc image")
    if xml2 and (stamp.get("inputs", {}).get("xml2") or {}).get("base_digest") not in (None, xml2.get("base_digest")):
        reasons.append("X-Men Legends II changed")
    return ("stale" if reasons else "current"), reasons, stamp


# ---------------------------------------------------------------------------------------------
# the manifest and verification (the real builder's xml1builder/manifest.py)

def sha1_file(path):
    digest = hashlib.sha1()
    size = 0
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            size += len(block)
            digest.update(block)
    return size, digest.hexdigest()


def load_manifest(out):
    manifest = read_json(pathlib.Path(out) / "_build" / "manifest.json")
    return manifest if isinstance(manifest, dict) and isinstance(manifest.get("files"), dict) else None


def check_files(out, files):
    """The area of <out> against the manifest's files: {files, ok, missing, changed, unreadable, extra}."""
    out = pathlib.Path(out)
    area = area_files(out)
    expected = {rel.lower(): (rel, entry) for rel, entry in files.items()}
    result = {"files": len(expected), "ok": 0, "missing": [], "changed": [], "unreadable": [], "extra": []}
    for low, (rel, entry) in sorted(expected.items()):
        want = {"size": entry.get("size"), "sha1": entry.get("sha1")}
        kind = entry.get("kind", "built")
        actual = area.get(low)
        if actual is None:
            result["missing"].append({"path": rel, "kind": kind, "expected": want})
            continue
        try:
            size, sha1 = sha1_file(out / actual)
        except OSError as error:
            result["unreadable"].append({"path": actual, "kind": kind, "error": type(error).__name__})
            continue
        if size != entry.get("size") or sha1 != entry.get("sha1"):
            result["changed"].append({"path": actual, "kind": kind, "expected": want, "found": {"size": size, "sha1": sha1}})
        else:
            result["ok"] += 1
    for low, actual in sorted(area.items()):
        if low not in expected:
            try:
                size = (out / actual).stat().st_size
            except OSError:
                size = None
            result["extra"].append({"path": actual, "size": size, "temp": ".tmp" in actual.lower()})
    return result


def group(code, items, limit=500):
    found = {"code": code, "count": len(items), "cause_hint": CAUSES.get(code, ""), "files": items[:limit]}
    kinds = {}
    for item in items:
        if item.get("kind"):
            kinds[item["kind"]] = kinds.get(item["kind"], 0) + 1
    if kinds:
        found["kinds"] = kinds
    return found


def groups_of(result, extra_groups=()):
    groups = [group(code, result.get(code) or []) for code in ("missing", "changed", "unreadable", "extra") if result.get(code)]
    return groups + [g for g in extra_groups if g.get("count")]


def counts_of(result, groups):
    counts = {"files": result.get("files", 0), "ok": result.get("ok", 0)}
    for found in groups:
        counts[found["code"]] = found["count"]
    return counts


def verify_report(out, command, state, reasons, counts, groups, stamp, version):
    """_build/verify-report.json: versions, the state, counts, groups - relative paths, sizes, hashes, codes only."""
    stamp = stamp or {}
    write_json(pathlib.Path(out) / "_build" / "verify-report.json", {
        "format": 1, "command": command, "verified": utc_now(),
        "builder": {"version": version["version"], "content_version": version["content_version"], "commit": version["commit"]},
        "build": {k: stamp.get(k) for k in ("builder", "finished", "profile", "inputs", "outputs")},
        "state": state, "reasons": reasons[:50], "counts": counts, "groups": groups,
        "python": sys.version.split()[0], "os": sys.platform})
    return pathlib.Path(out) / "_build" / "verify-report.json"


# ---------------------------------------------------------------------------------------------
# ini merge (WritePrivateProfileString semantics: only these keys; everything else stays)

def merge_ini(path, sections):
    path = pathlib.Path(path)
    raw = path.read_bytes() if path.exists() else b""
    newline = "\r\n" if b"\r\n" in raw or not raw else "\n"
    lines = raw.decode("utf-8", errors="replace").splitlines()
    for section, keys in sections.items():
        start = next((i for i, line in enumerate(lines) if line.strip().lower() == f"[{section.lower()}]"), None)
        if start is None:
            if lines and lines[-1].strip():
                lines.append("")
            lines.append(f"[{section}]")
            lines += [f"{k}={v}" for k, v in keys.items()]
            continue
        end = next((i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")), len(lines))
        for key, value in keys.items():
            index = next((i for i in range(start + 1, end) if lines[i].split("=", 1)[0].strip().lower() == key.lower() and "=" in lines[i]), None)
            if index is None:
                insert = end
                while insert > start + 1 and not lines[insert - 1].strip():
                    insert -= 1
                lines.insert(insert, f"{key}={value}")
                end += 1
            else:
                lines[index] = f"{lines[index].split('=', 1)[0]}={value}"
    temp = path.with_name(path.name + f".tmp{os.getpid()}")
    temp.write_bytes((newline.join(lines) + newline).encode("utf-8"))
    os.replace(temp, path)


# ---------------------------------------------------------------------------------------------
# the cache (the real layout: <cache>/<disc_id>/disc/stage.json, prepared/<stage>-v1-<key>/stage.json)

def version_info():
    data = read_json(HERE / "fake-builder.json", {}) or {}
    return {"version": data.get("version", "1.0.0"), "content_version": int(data.get("content_version", 3)),
            "commit": data.get("commit", "fake000")}


def free_bytes(path):
    path = pathlib.Path(path)
    while not path.exists() and path.parent != path:
        path = path.parent
    return shutil.disk_usage(path).free


def volume(path):
    return os.path.splitdrive(str(pathlib.Path(path).resolve()))[0].upper() + "\\"


def cache_bytes(cache):
    return folder_bytes(cache) if cache and pathlib.Path(cache).exists() else 0


def stage_key(iso, stage_id):
    return hashlib.sha1(f"{iso['digest']}:{stage_id}:1".encode()).hexdigest()[:12]


def stage_dir(cache, iso, stage_id):
    root = pathlib.Path(cache) / iso["disc_id"]
    if stage_id == "extract":
        return root / "disc"
    return root / "prepared" / f"{PREPARED_NAMES[stage_id]}-v1-{stage_key(iso, stage_id)}"


def cached_stages(cache, iso, movies=True):
    if not cache or not iso:
        return set()
    disc = read_json(stage_dir(cache, iso, "extract") / "stage.json")
    if not disc or (movies and not disc.get("movies", True)):
        return set()
    found = {"extract"}
    for stage_id in ("tables", "scripts", "sound", "music"):
        if (stage_dir(cache, iso, stage_id) / "stage.json").is_file():
            found.add(stage_id)
    return found


def published_stages(disc_root):
    """The prepare stages with a published directory for this disc (info without --iso)."""
    disc_root = pathlib.Path(disc_root)
    found = ["extract"] if (disc_root / "disc" / "stage.json").is_file() else []
    for stage_id in ("tables", "scripts", "sound", "music"):
        if any((d / "stage.json").is_file() for d in (disc_root / "prepared").glob(f"{PREPARED_NAMES[stage_id]}-v*")):
            found.append(stage_id)
    return found


def cached_disc(cache, disc_id=None):
    """info.iso of a disc prepared in the cache (for a build without --iso), or None."""
    if not cache or not pathlib.Path(cache).is_dir():
        return None
    found = [d for d in pathlib.Path(cache).iterdir() if (d / "disc" / "stage.json").is_file() and (disc_id is None or d.name == disc_id)]
    if len(found) != 1:
        return None
    return (read_json(found[0] / "disc" / "stage.json", {}) or {}).get("identity")


def space_report(iso, out, cache, movies=True):
    need_out = int(iso.get("fake", {}).get("need_bytes", 0)) or (4_430_000_000 if movies else 3_350_000_000)
    need_cache = int(iso.get("fake", {}).get("cache_need_bytes", 0)) or 3_210_000_000
    report = {}
    if out:
        present = folder_bytes(out) if pathlib.Path(out).exists() else 0
        want = max(0, int((need_out - present) * 1.1))
        report["out"] = {"volume": volume(out), "need": want, "free": free_bytes(out)}
        report["out"]["ok"] = report["out"]["free"] >= want
    if cache:
        want = max(0, int((need_cache - cache_bytes(pathlib.Path(cache) / iso["disc_id"])) * 1.1))
        report["cache"] = {"volume": volume(cache), "need": want, "free": free_bytes(cache)}
        report["cache"]["ok"] = report["cache"]["free"] >= want
        if out and report["cache"]["volume"].lower() == report["out"]["volume"].lower():
            both = report["out"]["need"] + want
            report["out"]["ok"] = report["cache"]["ok"] = report["out"]["free"] >= both
    return report


class FileLock:
    """<out>/_build/lock and <cache>/lock: exclusive create with the pid; a dead holder's lock is taken over."""

    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.held = False

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                try:
                    holder = int(self.path.read_text().strip() or 0)
                except (OSError, ValueError):
                    holder = 0
                if holder and pid_alive(holder):
                    return holder
                self.path.unlink(missing_ok=True)
                continue
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            self.held = True
            return None
        return -1

    def release(self):
        if self.held:
            self.path.unlink(missing_ok=True)
            self.held = False


def pid_alive(pid):
    import ctypes
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(handle)
    return code.value == 259  # STILL_ACTIVE


# ---------------------------------------------------------------------------------------------
# commands

def cmd_info(args, out, version):
    info = {}
    exit_code = 0
    failure = None
    iso = None
    try:
        if args.iso:
            iso = identify_iso(args.iso)
            info["iso"] = {k: v for k, v in iso.items() if k != "fake"}
            if not iso["known"]:
                out.event("warning", stage="probe", code="W_ISO_UNKNOWN_DUMP", msg="This disc image is not in the list of known dumps; the build checks it anyway.")
        xml2 = check_xml2(args.xml2) if args.xml2 else None
        if xml2:
            info["xml2"] = xml2
        if args.out:
            state, reasons, stamp = out_state(args.out, version, iso, xml2)
            info["out"] = {"path": mask(args.out), "state": state, "reasons": reasons, "stamp": stamp}
        stamp_disc = ((info.get("out") or {}).get("stamp") or {}).get("inputs", {}).get("disc", {}).get("disc_id")
        disc_id = iso["disc_id"] if iso else stamp_disc
        if args.cache:
            cache = pathlib.Path(args.cache)
            stages = []
            if disc_id and (cache / disc_id).is_dir():
                stages = sorted(cached_stages(cache, iso, not args.no_movies), key=[s[0] for s in STAGES].index) if iso \
                    else published_stages(cache / disc_id)
            info["cache"] = {"path": mask(cache), "bytes": cache_bytes(cache),
                             "disc_bytes": cache_bytes(cache / disc_id) if disc_id else 0, "disc_id": disc_id, "stages": stages}
        if iso:
            info["space"] = space_report(iso, args.out, args.cache, not args.no_movies)
            cores = os.cpu_count() or 4
            first = int(360 + 450 * 4 / min(cores, 16))
            cached = set((info.get("cache") or {}).get("stages") or [])
            info["estimate"] = {"cores": cores, "jobs": cores, "kernel": True,
                                "first_build_s": 300 if {"extract", "tables", "scripts", "sound", "music"} <= cached else first,
                                "rebuild_s": 300}
    except Failure as f:
        failure = f
    if failure:
        out.event("error", stage="probe", code=failure.code, msg=failure.msg, hint=failure.hint, detail=failure.detail)
        exit_code = failure.exit_code
    if iso and (iso.get("fake") or {}).get("odd_events"):
        odd_events(out)
    out.event("result", ok=exit_code == 0, exit=exit_code, info=info)
    return exit_code


# The launcher's parser against output of unexpected shapes (a newer or broken builder): nulls,
# numbers and arrays where it reads strings, missing fields, lines that are not events at all.
ODD_LINES = [
    '{"ev": null}', '{"ev": 5}', '[1, 2, 3]', '"just a string"', 'not json at all {', '{}', 'null',
    '{"ev": "hello", "builder": 5, "content_version": "x", "v": null}',
    '{"ev": "plan", "stages": [null, 5, "x", {"id": 7, "title": null, "weight": "heavy", "cached": "yes"}]}',
    '{"ev": "plan", "stages": {"id": "probe"}}',
    '{"ev": "stage", "id": null, "state": 5, "seconds": "x"}',
    '{"ev": "stage", "id": "probe", "state": "done", "seconds": null}',
    '{"ev": "progress", "stage": 5, "done": "a", "total": null, "unit": [], "pct": {}, "overall": "x", "eta_s": []}',
    '{"ev": "progress", "stage": "probe", "done": -1, "total": 1e300, "overall": 1e308, "eta_s": -5}',
    '{"ev": "log", "stage": null, "msg": 5, "level": []}',
    '{"ev": "warning", "code": 5, "msg": null, "count": "x", "detail": [1, 2]}',
    '{"ev": "warning", "code": "W_EXTRA_FILES", "msg": {}, "count": -3, "detail": {"files": "not a list"}}',
    '{"ev": "error", "code": null, "msg": 5, "hint": [], "detail": "text", "stage": {}}',
    '{"ev": "result", "exit": "0", "ok": "yes"}',
]


def odd_events(out):
    with out.lock:
        for line in ODD_LINES:
            sys.stdout.write(line + "\n")
        sys.stdout.flush()


def cmd_verify(args, out, version):
    target = pathlib.Path(args.out)
    iso = identify_iso(args.iso) if args.iso and pathlib.Path(args.iso).is_file() else None
    xml2 = check_xml2(args.xml2) if args.xml2 else None
    state, reasons, stamp = out_state(target, version, iso, xml2)
    extra_groups = []
    if iso and not iso["known"]:
        extra_groups.append(group("disc_unknown", [{"path": pathlib.Path(args.iso).name, "xbe_md5": iso["xbe_md5"]}]))
    if iso and stamp and ((stamp.get("inputs") or {}).get("disc") or {}).get("digest") not in (None, iso["digest"]):
        extra_groups.append(group("disc_changed", [{"path": pathlib.Path(args.iso).name}]))
    result = {"files": 0, "ok": 0}
    if state in ("current", "stale"):
        manifest = load_manifest(target)
        if manifest is None:
            state = "damaged"
            reasons.append("the build has no file manifest (_build/manifest.json): rebuild to repair it")
        else:
            result = check_files(target, manifest["files"])
            for code in REPAIRS:
                reasons += [f"{code}: {x['path']}" for x in result[code][:200]]
            if any(result[code] for code in REPAIRS):
                state = "damaged"
    if stamp:
        modified = ((stamp.get("inputs") or {}).get("xml2") or {}).get("modified") or []
        extra_groups.append(group("xml2_not_retail", [{"path": m} for m in modified]))
    groups = groups_of(result, extra_groups)
    counts = counts_of(result, groups)
    report = None
    if state not in ("absent", "foreign") and (target / "_build").is_dir():
        report = verify_report(target, "verify", state, reasons, counts, groups, stamp, version)
    out.human(f"verify: {state} ({result.get('files', 0)} files checked; {counts})")
    out.event("result", ok=True, exit=0, verify={"state": state, "reasons": reasons, "files": result.get("files", 0),
                                                 "ok": result.get("ok", 0), "counts": counts,
                                                 "groups": [dict(g, files=g["files"][:20]) for g in groups],
                                                 "stamp": stamp, "report": mask(report) if report else None})
    return 0


def remove_empty_dirs(root, keep_top=()):
    root = pathlib.Path(root)
    keep = {k.lower() for k in keep_top}
    for folder in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        if folder.relative_to(root).parts[0].lower() in keep:
            continue
        try:
            folder.rmdir()
        except OSError:
            pass


def cmd_clean(args, out, version):
    result = {"files": 0, "bytes": 0, "kept": [], "cache_bytes": 0, "dry_run": bool(args.dry_run), "failed": []}
    if not args.out and not args.cache:
        raise Failure(2, "E_USAGE", "clean needs --out or --cache.", "", {})
    disc_id = None
    if args.out:
        target = pathlib.Path(args.out)
        if target.exists():
            if not target.is_dir() or not builder_folder(target):
                raise Failure(2, "E_OUT_FOREIGN", "This folder was not made by the builder, so it deletes nothing in it.",
                              "Delete the folder yourself if you no longer need it.", {"out": mask(target)})
            stamp = read_json(target / "_build" / "stamp.json") or read_json(target / "_build" / "building.json") or {}
            disc_id = (stamp.get("inputs") or {}).get("disc", {}).get("disc_id")
            lock = FileLock(target / "_build" / "lock")
            if lock.acquire():
                raise Failure(2, "E_OUT_LOCKED", "A build is writing to this folder.", "Wait for it to finish.", {})
            try:
                wanted = {r.lower() for r in ((load_manifest(target) or {}).get("files") or {})}
                wanted |= {line.strip().lower() for line in (read_text(target / "_build" / "journal.txt") or "").splitlines() if line.strip()}
                for low, rel in area_files(target).items():
                    if low in wanted or ".tmp" in low:
                        path = target / rel
                        size = path.stat().st_size
                        if not args.dry_run:
                            path.unlink()
                        result["files"] += 1
                        result["bytes"] += size
                mods = next((c for c in target.iterdir() if c.name.lower() == "mods"), None)
                if args.mods and mods is not None:
                    result["files"] += sum(1 for p in mods.rglob("*") if p.is_file())
                    if not args.dry_run:
                        shutil.rmtree(mods)
            finally:
                lock.release()
            if not args.dry_run:
                shutil.rmtree(target / "_build", ignore_errors=True)
                remove_empty_dirs(target, keep_top=() if args.mods else ("mods",))
            result["kept"] = sorted(p.name for p in target.iterdir()) if target.exists() else []
            if not args.dry_run and target.exists() and not any(target.iterdir()):
                target.rmdir()
    if args.cache:
        cache = pathlib.Path(args.cache)
        if cache.is_dir():
            lock = FileLock(cache / "lock")
            if lock.acquire():
                raise Failure(2, "E_CACHE_LOCKED", "A build is using the build cache.", "Wait for it to finish.", {})
            try:
                if args.out:
                    victims = [cache / disc_id] if disc_id and (cache / disc_id).is_dir() else []
                else:
                    victims = [d for d in cache.iterdir() if d.is_dir() and ((d / "disc.json").is_file() or (d / "disc").is_dir())]
                for victim in victims:
                    result["cache_bytes"] += cache_bytes(victim)
                    if not args.dry_run:
                        shutil.rmtree(victim)
            finally:
                lock.release()
    out.human(f"clean: {result['files']} files, {result['bytes']} bytes; cache {result['cache_bytes']} bytes")
    out.event("result", ok=True, exit=0, clean=result)
    return 0


def read_text(path):
    try:
        return pathlib.Path(path).read_text(encoding="utf-8")
    except OSError:
        return None


def cmd_build(args, out, version, cancel):
    for name in ("xml2", "out"):
        if not getattr(args, name):
            raise Failure(2, "E_USAGE", f"build needs --{name}.", "", {})
    target = pathlib.Path(args.out).resolve()
    cache = pathlib.Path(args.cache).resolve() if args.cache else None
    movies = not args.no_movies
    warnings = []

    def warn(code, msg, detail=None, stage="probe", count=None):
        fields = {"stage": stage, "code": code, "msg": msg}
        if detail:
            fields["detail"] = detail
        if count is not None:
            fields["count"] = count
        out.event("warning", **fields)
        warnings.append(count if count is not None else 1)

    if args.iso:
        iso = identify_iso(args.iso)
    else:
        prefer = ((read_json(target / "_build" / "stamp.json") or read_json(target / "_build" / "building.json") or {})
                  .get("inputs", {}).get("disc", {}).get("disc_id"))
        iso = cached_disc(cache, prefer) or (cached_disc(cache) if prefer else None)
        if not iso:
            raise Failure(2, "E_USAGE", "build needs --iso (the build cache holds no prepared disc to use instead).",
                          "Choose your X-Men Legends Xbox disc image.", {"cache": mask(cache) if cache else None})
        if movies and not (read_json(stage_dir(cache, iso, "extract") / "stage.json", {}) or {}).get("movies", True):
            raise Failure(3, "E_CACHE_NO_MOVIES", "The cached disc was prepared without its movies.",
                          "Pass --iso to add them, or build with --no-movies.", {})
    if not iso["known"]:
        warn("W_ISO_UNKNOWN_DUMP", "This disc image is not in the list of known dumps; the build checks it anyway.")
    fake = iso.get("fake") or {}
    cancel.ignore = bool(fake.get("ignore_cancel"))
    speed = float(fake.get("speed", 1.0))
    xml2 = check_xml2(args.xml2)
    check_out(target, args.xml2, cache, args.iso)
    space = space_report(iso, target, cache, movies)
    for where in ("out", "cache"):
        if where in space and not space[where]["ok"]:
            raise Failure(4, "E_SPACE", f"Not enough free space on {space[where]['volume']}.",
                          "Free up some space or choose a folder on another drive.", space[where])
    if args.link_base:
        warn("W_LINK_BASE", "--link-base (hard links) is not supported yet: the base files are copied.")

    build = target / "_build"
    build.mkdir(parents=True, exist_ok=True)
    out_lock = FileLock(build / "lock")
    holder = out_lock.acquire()
    if holder:
        raise Failure(2, "E_OUT_LOCKED", "Another build is writing to this folder.", "Wait for it to finish.", {"pid": holder})
    cache_lock = FileLock(cache / "lock") if cache else None
    try:
        if cache_lock:
            holder = cache_lock.acquire()
            if holder:
                raise Failure(2, "E_CACHE_LOCKED", "Another build is using the build cache.", "Wait for it to finish.",
                              {"pid": holder, "cache": mask(cache)})
        out.open_log(build / "builder.log")
        out.human(f"xml1-builder {version['version']} (fake) build: iso={mask(args.iso) if args.iso else '(from the cache)'} "
                  f"xml2={mask(args.xml2)} out={mask(target)}")
        return run_build(args, out, version, cancel, iso, xml2, target, cache, movies, speed, fake, warn, warnings)
    finally:
        if cache_lock:
            cache_lock.release()
        out_lock.release()


def run_build(args, out, version, cancel, iso, xml2, target, cache, movies, speed, fake, warn, warnings):
    build = target / "_build"
    started = time.monotonic()
    write_json(build / "building.json", {"started": utc_now(), "builder": version,
                                         "inputs": {"disc": {"disc_id": iso["disc_id"]}}, "movies": movies})
    journal = open(build / "journal.txt", "a", encoding="utf-8")
    previous = load_manifest(target)
    cached = cached_stages(cache, iso, movies)
    plan = [{"id": s[0], "title": s[1], "weight": s[2], "cached": s[0] in cached} for s in STAGES]
    out.event("plan", stages=plan)
    total_weight = sum(0.1 if p["cached"] else p["weight"] for p in plan)
    done_weight = 0.0
    files = {}
    stage_seconds = {}
    finish_extra = []

    def unit_time(stage_weight, count):
        return 0.12 * stage_weight * speed / max(count, 1)

    def write(rel, data, owner):
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        temp = dest.with_name(dest.name + f".tmp{os.getpid()}")
        temp.write_bytes(data)
        os.replace(temp, dest)
        journal.write(rel + "\n")
        journal.flush()
        files[rel] = {"size": len(data), "sha1": hashlib.sha1(data).hexdigest(), "kind": "built", "owner": owner}

    try:
        for stage_id, title, weight, is_cache, unit, count in STAGES:
            cancel.check()
            is_cached = stage_id in cached
            stage_weight = 0.1 if is_cached else weight
            CURRENT["stage"] = stage_id
            out.event("stage", id=stage_id, state="start")
            stage_start = time.monotonic()
            if stage_id == "extract" and not args.iso:
                out.event("log", level="info", stage="extract", msg=f"disc: using {mask(stage_dir(cache, iso, 'extract'))} (no --iso)")
            base = []
            if stage_id == "sync":
                base = sorted(base_listing(args.xml2))
                count = len(base)
            steps = 1 if is_cached else max(count, 1)
            chunks = min(steps, 20)  # fewer, bigger steps for the made-up counts; every step is a cancel checkpoint
            for chunk in range(chunks):
                cancel.check()
                if stage_id == fake.get("fail_stage") and chunk == chunks // 2:
                    raise Failure(1, "E_PIPELINE", f"A step of the build failed: {title}.", "This is a bug in the builder: please report it.",
                                  {"module": stage_id, "failed": [stage_id], "errors": 1, "first": [f"[{stage_id}] fake failure"]}, stage_id)
                if stage_id == fake.get("io_error_stage") and chunk == chunks // 2:
                    raise Failure(6, "E_IO", f"A file could not be read or written: {mask(target)} is in use.",
                                  "Close X-Men Legends if it is running and check the folder is writable, then try again.", {"path": mask(target)}, stage_id)
                if stage_id == fake.get("crash_stage") and chunk == chunks // 2:
                    raise RuntimeError(f"fake crash in {stage_id}")
                if not is_cached:
                    time.sleep(unit_time(weight, chunks))
                done_units = int(steps * (chunk + 1) / chunks)
                overall = 100.0 * (done_weight + stage_weight * (chunk + 1) / chunks) / total_weight
                elapsed = time.monotonic() - started
                out.progress(stage_id, done_units, steps, unit, overall, elapsed / max(overall, 0.1) * (100 - overall))

            if stage_id == "sync":
                for rel in base:
                    cancel.check()
                    source, dest = pathlib.Path(args.xml2) / rel, target / rel
                    stat = source.stat()
                    if not dest.is_file() or dest.stat().st_size != stat.st_size or int(dest.stat().st_mtime) != int(stat.st_mtime):
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        temp = dest.with_name(dest.name + f".tmp{os.getpid()}")
                        shutil.copy2(source, temp)
                        os.replace(temp, dest)
                        journal.write(rel + "\n")
                    size, sha1 = sha1_file(source)
                    files[rel] = {"size": size, "sha1": sha1, "kind": "base", "src": {"size": size, "mtime_ns": stat.st_mtime_ns, "sha1": sha1}}
                journal.flush()
            elif stage_id == "content":
                for rel, owner in list(CONTENT_FILES.items()) + (list(MOVIE_FILES.items()) if movies else []):
                    cancel.check()
                    write(rel, f"fake X-Men Legends port file {rel} (content {version['content_version']}); no game data\n".encode(), owner)
            elif stage_id == "sweep":
                for rel in ((previous or {}).get("files") or {}):
                    if rel not in files and not owned(rel):
                        (target / rel).unlink(missing_ok=True)
                remove_empty_dirs(target, keep_top=("mods",))
                write_json(build / "registry.json", {"version": 1, "entries": {rel.lower(): {"rel": rel, "size": e["size"], "owner": e["owner"], "sha1": e["sha1"]}
                                                                              for rel, e in files.items() if e["kind"] == "built"}})
            elif stage_id == "validate":
                out.event("log", level="info", stage="validate", msg=f"{len(files)} files checked, 0 errors")
                if fake.get("validate_errors"):
                    raise Failure(1, "E_VALIDATE", "The finished build did not pass its checks.",
                                  "This is a bug in the builder: please report it.", {"errors": int(fake["validate_errors"])}, stage_id)
            elif stage_id == "finish":
                # every file read back against its expected hash; a damaged base copy is copied again
                check = check_files(target, files)
                for item in check["missing"] + check["changed"]:
                    entry = files.get(item["path"]) or next(e for r, e in files.items() if r.lower() == item["path"].lower())
                    if entry["kind"] != "base":
                        raise Failure(6, "E_IO", f"{item['path']} changed right after the build wrote it (an antivirus program, or a disk error).",
                                      "", {"path": item["path"]}, "finish")
                    shutil.copy2(pathlib.Path(args.xml2) / item["path"], target / item["path"])
                if check["unreadable"]:
                    first = check["unreadable"][0]
                    raise Failure(6, "E_IO", f"{first['path']} can't be read after the build ({first['error']}).",
                                  "Close X-Men Legends if it is running and check the folder is writable, then try again.",
                                  {"path": first["path"], "count": len(check["unreadable"])}, "finish")
                extra = [x for x in check["extra"] if not x.get("temp")]
                if extra:
                    warn("W_EXTRA_FILES", f"{len(extra)} file(s) in the game folders that the build did not make (first: {extra[0]['path']})",
                         {"files": [x["path"] for x in extra[:20]]}, stage="finish")
                if xml2["modified_count"]:
                    warn("W_XML2_MODIFIED", f"{xml2['modified_count']} file(s) of X-Men Legends II differ from a retail install "
                                            f"(first: {xml2['modified'][0]}); the build used them as they are.",
                         {"files": xml2["modified"][:20]}, stage="finish")
                write_json(build / "manifest.json", {"format": 1, "builder": version["version"], "created": utc_now(),
                                                     "files": dict(sorted(files.items()))}, indent=0)
                if not args.no_ini:
                    merge_ini(target / "xml2-fix.ini", PORT_INI)
                finish_extra = extra
            if is_cache and not is_cached and cache:
                folder = stage_dir(cache, iso, stage_id)
                record = {"stage": PREPARED_NAMES[stage_id], "version": 1, "key": stage_key(iso, stage_id), "disc_id": iso["disc_id"]}
                if stage_id == "extract":
                    record.update(identity=iso, movies=movies)
                write_json(folder / "stage.json", record)
                write_json(cache / iso["disc_id"] / "disc.json", {"disc_id": iso["disc_id"], "title": iso["title"],
                                                                  "title_id": iso["title_id"], "known": iso["known"], "updated": utc_now()})
            if stage_id in ("content", "validate"):
                count_warnings = int(fake.get("warnings", 204)) // 2
                warn("W_PIPELINE", f"{count_warnings} warnings (details in report.json)", stage=stage_id, count=count_warnings)
            seconds = round(time.monotonic() - stage_start, 2)
            stage_seconds[stage_id] = {"seconds": seconds, "cached": is_cached}
            out.event("stage", id=stage_id, state="done", seconds=seconds, cached=is_cached)
            done_weight += stage_weight
    finally:
        journal.close()

    seconds = round(time.monotonic() - started, 1)
    total_warnings = sum(warnings)
    write_json(build / "report.json", {"errors": 0, "warnings": total_warnings, "seconds": seconds, "files": len(files),
                                       "builder": {"version": version["version"], "stages": stage_seconds}})
    built = sum(1 for e in files.values() if e["kind"] == "built")
    digest = hashlib.sha1("".join(f"{rel.lower()}\t{e['size']}\t{e['sha1']}\n" for rel, e in sorted(files.items())).encode()).hexdigest()
    stamp = {
        "format": 1,
        "builder": {"version": version["version"], "commit": version["commit"], "content_version": version["content_version"]},
        "source": {"project": "Legends Classic (fake builder)"},
        "profile": dict(PROFILE, movies=movies),
        "inputs": {"disc": {"format": iso["format"], "title_id": iso["title_id"], "xbe_md5": iso["xbe_md5"], "zip_digest": iso["zip_digest"],
                            "digest": iso["digest"], "disc_id": iso["disc_id"], "known": iso["dump"] or False},
                   "xml2": {"exe_md5": xml2["exe_md5"], "exe": xml2["exe"], "base_digest": xml2["base_digest"], "base_files": xml2["base_files"],
                            "modified": xml2["modified"], "modified_count": xml2["modified_count"]}},
        "requires": {"xml2fix": ">=1.2.0", "ini": PORT_INI},
        "outputs": {"files": len(files), "bytes": sum(e["size"] for e in files.values()), "built_files": built,
                    "base_files": len(files) - built, "manifest_sha1": digest, "registry_sha1": digest},
        "result": {"errors": 0, "warnings": total_warnings, "seconds": seconds, "repaired": 0},
        "finished": utc_now(),
    }
    summary = {"state": "current", "files": len(files), "ok": len(files), "repaired": 0, "extra": len(finish_extra)}
    groups = [g for g in (group("extra", finish_extra), group("xml2_not_retail", [{"path": m} for m in xml2["modified"]])) if g["count"]]
    verify_report(target, "build", "current", [], summary, groups, stamp, version)
    write_json(build / "stamp.json", stamp)
    (build / "building.json").unlink(missing_ok=True)
    (build / "journal.txt").unlink(missing_ok=True)
    if args.drop_cache and cache and (cache / iso["disc_id"]).exists():
        shutil.rmtree(cache / iso["disc_id"])
    out.human(f"build finished in {seconds} s: {len(files)} files verified, {total_warnings} warnings")
    out.event("result", ok=True, exit=0, out=mask(target), report=mask(build / "report.json"), log=mask(build / "builder.log"),
              errors=0, warnings=total_warnings, stamp=stamp, verify=summary, seconds=seconds)
    return 0


# ---------------------------------------------------------------------------------------------

def parse(argv):
    parser = argparse.ArgumentParser(prog="xml1-builder", add_help=True)
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--events", choices=["jsonl", "text"], default="text")
    parser.add_argument("--log")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("command", nargs="?", choices=["info", "build", "verify", "clean"])
    parser.add_argument("--iso")
    parser.add_argument("--xml2")
    parser.add_argument("--out")
    parser.add_argument("--cache")
    parser.add_argument("--movies", action="store_true")
    parser.add_argument("--no-movies", action="store_true")
    parser.add_argument("--keep-cache", action="store_true")
    parser.add_argument("--drop-cache", action="store_true")
    parser.add_argument("--link-base", action="store_true")
    parser.add_argument("--jobs", type=int)
    parser.add_argument("--no-ini", action="store_true")
    parser.add_argument("--allow-unknown-exe", action="store_true")
    parser.add_argument("--deep", action="store_true")
    parser.add_argument("--mods", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    try:
        args = parse(argv if argv is not None else sys.argv[1:])
    except SystemExit as exit_:
        return 2 if exit_.code else 0
    version = version_info()
    out = Output(args.events == "jsonl", args.quiet, args.log)
    if args.version:
        if out.jsonl:
            out.event("hello", v=SCHEMA, builder=version["version"], content_version=version["content_version"],
                      commit=version["commit"], pid=os.getpid())
            out.event("result", ok=True, exit=0, version=version["version"], content_version=version["content_version"])
        else:
            print(f"xml1-builder {version['version']} (content {version['content_version']}, fake)")
        return 0
    out.event("hello", v=SCHEMA, builder=version["version"], content_version=version["content_version"],
              commit=version["commit"], pid=os.getpid())
    if not args.command:
        out.event("error", stage="probe", code="E_USAGE", msg="No command given (info, build, verify or clean).", hint="", detail={})
        out.event("result", ok=False, exit=2)
        return 2
    out.write_log(f"command line: {mask(' '.join(sys.argv))}")
    cancel = CancelFlag(out.jsonl)
    try:
        if args.command == "info":
            return cmd_info(args, out, version)
        if args.command == "verify":
            if not args.out:
                raise Failure(2, "E_USAGE", "verify needs --out.", "", {})
            return cmd_verify(args, out, version)
        if args.command == "clean":
            return cmd_clean(args, out, version)
        return cmd_build(args, out, version, cancel)
    except Cancelled:
        out.human(f"cancelled during {CURRENT['stage']}; the next build resumes from the cache")
        out.event("result", ok=False, exit=5, cancelled=True, stage=CURRENT["stage"])
        return 5
    except Failure as f:
        if not out.log and args.cache and args.command == "build":
            out.open_log(pathlib.Path(args.cache) / "logs" / f"builder-{datetime.datetime.now():%Y%m%d-%H%M%S}.log", rotate=False)
        stage = (f.stage or CURRENT["stage"]) if args.command == "build" else (f.stage or "probe")
        out.event("error", stage=stage, code=f.code, msg=f.msg, hint=f.hint, detail=f.detail)
        out.event("result", ok=False, exit=f.exit_code, log=mask(out.log_path) if out.log_path else None)
        return f.exit_code
    except Exception as e:  # noqa: BLE001 - the builder's own "internal error"
        import traceback
        out.human(traceback.format_exc())
        out.event("error", stage=CURRENT["stage"], code="E_INTERNAL", msg=f"Internal error: {type(e).__name__}: {e}",
                  hint="This is a bug in the builder: please report it with the build log.", detail={})
        out.event("result", ok=False, exit=70)
        return 70


if __name__ == "__main__":
    sys.exit(main())
