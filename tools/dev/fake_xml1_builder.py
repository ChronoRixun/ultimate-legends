"""A fake xml1-builder for the launcher's tests: the CLI and the event schema of the real builder
(BUILDER_DESIGN.md section 2), acted out on tiny test folders, so the launcher's X-Men Legends
entry can be built and tested without game data and without the real pipeline.

    python fake_xml1_builder.py --version
    python fake_xml1_builder.py info    --iso PATH [--xml2 DIR] [--out DIR] [--cache DIR]
    python fake_xml1_builder.py build   --iso PATH --xml2 DIR --out DIR [--movies | --no-movies] [--cache DIR]
                                        [--keep-cache | --drop-cache] [--link-base] [--jobs N] [--no-ini]
                                        [--allow-unknown-exe]
    python fake_xml1_builder.py verify  --out DIR [--iso PATH] [--xml2 DIR] [--deep]
    python fake_xml1_builder.py clean   [--out DIR] [--mods] [--cache DIR] [--dry-run]
    global: [--events jsonl] [--log FILE] [--quiet]

The launcher runs it as xml1-builder.exe: `make_package()` lays out a PyInstaller-style folder
(xml1-builder.exe = tools/dev/native/builder_shim.c, _internal/xml1-builder.py = this file,
_internal/python.txt, _internal/fake-builder.json with the version) and zips it with a
xml1-builder.json manifest, as the real release does (section 4.5).

What is real here: arguments, exit codes (2.2), the JSON-lines events on stdout with human text
on stderr (2.3), cancel by a `cancel` line or EOF on stdin (2.5), the lock, building.json and the
stamp written last (2.6, 2.8), the state machine (2.7), the log rotation (2.4), keeping
dinput.dll / xml2-fix.* / mods in <out> (F3), merging the port's ini keys without touching the
launcher's (3.5), and clean deleting only what the build registered.

What is fake: the inputs and the work. A disc image is a small test file made by
`make_fake_iso()`: the Xbox (XDVDFS) magic at 0x10000, followed by a JSON "certificate" (title id,
title, files) - or the magic of a PS2 / GameCube / compressed image, so the input errors can be
triggered. Its "fake" object steers the run: {"speed": seconds multiplier, "fail_stage": id,
"crash_stage": id, "io_error_stage": id, "need_bytes": n, "cache_need_bytes": n, "ignore_cancel": true, "warnings": n,
"movies": true}. The "XML2 install" is any small folder with XMen2.exe and Data/herostat.engb.
The build copies it into <out> and writes a few made-up content files; nothing in it is game
data. The fake refuses folders or images larger than 64 MB, so it never works on a real install.

Beyond the design (the real builder should match these; see the launcher's xml1 code):
- `info` puts what it found into the result event: result.info = {iso, xml2, out, space, cache,
  estimate}; `verify` into result.verify, `clean` into result.clean, `--version` into
  result.version / result.content_version.
- `info` works without --iso (the game page asks for the state of a build whose disc image may be
  gone) and `clean --cache DIR` without --out deletes only the build cache ("Free up").
- error codes the design leaves open: E_OUT_LOCKED (2: another build holds <out>/_build/lock),
  E_PIPELINE (1: a module failed), E_VALIDATE (1), E_IO (6), E_INTERNAL (70), E_USAGE (2).
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import sys
import threading
import time
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
START = time.monotonic()
SCHEMA = 1

XDVDFS_MAGIC = b"MICROSOFT*XBOX*MEDIA"
XML1_TITLE_ID = "0x4156001E"
KNOWN_XBE_MD5 = {"1e1a766ae4dc9f5f0151aa4ce029f362": "xml1-world-v1"}
REFUSE_BYTES = 64 * 1024 * 1024
PROXY_NAMES = ("dinput.dll",)
PROXY_PREFIXES = ("xml2-fix.",)
PROFILE = {"frontend": "xml1", "forced_teams": "seat", "newgame": "keepteam", "xp_curve": "xml1", "tiles": "used",
           "hero_roster": "21", "hero_icons": "xml1", "hero_bleed": "on", "blackbird": "menu", "npc_scaling": "off"}
PORT_INI = {"Game": {"NewGameTeam": "wolverine", "ResetUnlocks": "0", "SaveFolder": "X-Men Legends", "ForcedTeams": "1",
                     "PostgameScript": "x1/menus/postgame", "MainMenuItems": "button1,button2,button3,button4,button5,button6,button7",
                     "XPCurve": "xml1"},
            "Limits": {"ActorSlots": "127", "ResourceNames": "1024"}}

# (id, title, weight, cache stage, unit, count): the order of a build, weights as measured seconds (section 1.5).
STAGES = [
    ("probe", "Checking your files", 1, False, "files", 4),
    ("extract", "Reading the disc", 6, True, "files", 1888),
    ("tables", "Preparing tables", 1, True, "tables", 6),
    ("scripts", "Rewriting scripts", 1, True, "scripts", 1536),
    ("sound", "Converting sound banks", 4, True, "banks", 155),
    ("music", "Fixing the music", 8, True, "banks", 61),
    ("sync", "Copying X-Men Legends II", 5, False, "files", 0),
    ("content", "Building the game", 10, False, "files", 8065),
    ("sweep", "Removing old files", 1, False, "files", 0),
    ("validate", "Checking the build", 3, False, "checks", 12),
    ("finish", "Finishing", 1, False, "files", 3),
]
CONTENT_FILES = ["data/xml1/herostat_x1.txt", "data/xml1/zoneinfo_x1.txt", "scripts/x1/menus/postgame.txt",
                 "ui/menus/x1_main.txt", "packages/generated/x1/nyc1_1.txt", "sounds/eng/x1_music.txt"]
MOVIE_FILES = ["movies/x1_intro.txt", "movies/x1_outro.txt"]


CURRENT = {"stage": "probe"}


class Cancelled(Exception):
    pass


class Failure(Exception):
    def __init__(self, exit_code, code, msg, hint="", detail=None, stage=None):
        super().__init__(msg)
        self.exit_code, self.code, self.msg, self.hint, self.detail, self.stage = exit_code, code, msg, hint, detail or {}, stage


# ---------------------------------------------------------------------------------------------
# test fixtures (used by tools/dev/xml1_cdp.py)

def make_fake_iso(path, *, kind="xiso", title_id=XML1_TITLE_ID, title="X-Men Legends", xbe_md5="1e1a766ae4dc9f5f0151aa4ce029f362",
                  incomplete=False, fake=None):
    """Writes a tiny test "disc image". kind: xiso (Xbox), ps2, gamecube, pc, cso."""
    path = pathlib.Path(path)
    data = bytearray(0x11000)
    if kind == "xiso":
        data[0x10000:0x10000 + len(XDVDFS_MAGIC)] = XDVDFS_MAGIC
        files = {"default.xbe": 4698112, "z/assetsfb.zip": 656461422, "sounds/zsds": 595000000, "movies/ntsc": 648000000}
        if incomplete:
            del files["z/assetsfb.zip"]
        cert = {"title_id": title_id, "title": title, "xbe_md5": xbe_md5, "files": files, "fake": fake or {}}
        data += json.dumps(cert).encode() + b"\0"
    elif kind in ("ps2", "pc"):
        data[0x8001:0x8006] = b"CD001"
        data[0x8028:0x8028 + 12] = b"SLUS_20000  " if kind == "ps2" else b"PC_DISC     "
    elif kind == "gamecube":
        data[0x1C:0x20] = bytes.fromhex("C2339F3D")
    elif kind == "cso":
        data[0:4] = b"CISO"
    path.write_bytes(bytes(data))
    return path


def make_fake_xml2(folder, exe_source=None):
    """A small stand-in for an X-Men Legends II install (never a real one)."""
    folder = pathlib.Path(folder)
    (folder / "Data").mkdir(parents=True, exist_ok=True)
    (folder / "Sounds" / "eng").mkdir(parents=True, exist_ok=True)
    if exe_source:
        shutil.copy2(exe_source, folder / "XMen2.exe")
    else:
        (folder / "XMen2.exe").write_bytes(b"MZ placeholder - not a real game")
    (folder / "Data" / "herostat.engb").write_bytes(b"stand-in")
    (folder / "Sounds" / "eng" / "shared.zss").write_bytes(b"stand-in" * 64)
    (folder / "build.ini").write_text("Language = ENG\n", encoding="utf-8")
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
        self.log = open(path, "a", encoding="utf-8")
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
# inputs

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


def identify_iso(path):
    """-> dict (format, title_id, title, known, dump, xbe_md5, fake, digest) or raises Failure(3)."""
    path = pathlib.Path(path)
    if path.is_dir():
        raise Failure(3, "E_ISO_NOT_XBOX", "This is a folder, not a disc image.",
                      "Choose the disc image file (.iso) of your X-Men Legends Xbox disc.", {"detected": "folder"})
    if not path.is_file():
        raise Failure(3, "E_ISO_NOT_FOUND", f"The disc image was not found: {mask(path)}",
                      "Choose the disc image again.", {"path": mask(path)})
    size = path.stat().st_size
    if size > REFUSE_BYTES:
        raise Failure(2, "E_USAGE", "The fake builder only reads its own test images.", "", {"size": size})
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] in (b"CISO", b"CCIM", b"ZISO"):
        raise Failure(3, "E_ISO_COMPRESSED", "This disc image is compressed (CSO/CCI).",
                      "Decompress it to a plain .iso with the tool that made it, then choose that file.", {"detected": data[:4].decode()})
    if data[0x1C:0x20] == bytes.fromhex("C2339F3D"):
        raise Failure(3, "E_ISO_NOT_XBOX", "This is a GameCube disc image.",
                      "The port is built from the Xbox version of X-Men Legends.", {"detected": "gamecube"})
    if data[0x8001:0x8006] == b"CD001":
        ps2 = b"SLUS_" in data[0x8000:0x9000] or b"SLES_" in data[0x8000:0x9000]
        raise Failure(3, "E_ISO_NOT_XBOX", "This is a PlayStation 2 disc image." if ps2 else "This is not an Xbox disc image.",
                      "The port is built from the Xbox version of X-Men Legends.", {"detected": "ps2" if ps2 else "iso9660"})
    offset = next((o for o in (0x18300000, 0x0FD90000, 0x02080000, 0) if data[o + 0x10000:o + 0x10000 + len(XDVDFS_MAGIC)] == XDVDFS_MAGIC), None)
    if offset is None:
        raise Failure(3, "E_ISO_NOT_XBOX", "This is not an Xbox disc image.",
                      "Choose a disc image made from your X-Men Legends Xbox disc.", {"detected": "unknown"})
    end = data.find(b"\0", 0x11000)
    try:
        cert = json.loads(data[0x11000:end if end > 0 else None])
    except ValueError:
        raise Failure(3, "E_ISO_INCOMPLETE", "The disc image has no default.xbe.", "The image may be damaged; make it again.", {})
    if cert.get("title_id") != XML1_TITLE_ID:
        raise Failure(3, "E_ISO_WRONG_GAME", f"This is a disc image of {cert.get('title') or 'another game'}, not X-Men Legends.",
                      "Choose a disc image of X-Men Legends for the Xbox.", {"title_id": cert.get("title_id"), "title": cert.get("title")})
    missing = [name for name in ("default.xbe", "z/assetsfb.zip", "sounds/zsds") if name not in cert.get("files", {})]
    if missing:
        raise Failure(3, "E_ISO_INCOMPLETE", "The disc image is missing game files (a demo disc or a bad rip?).",
                      "Make the disc image again from your X-Men Legends disc.", {"missing": missing})
    known = KNOWN_XBE_MD5.get(cert.get("xbe_md5", ""))
    digest = hashlib.sha1(json.dumps(cert, sort_keys=True).encode()).hexdigest()
    return {"path": mask(path), "format": "xiso", "title": cert.get("title"), "title_id": cert["title_id"],
            "xbe_md5": cert.get("xbe_md5"), "known": bool(known), "dump": known or "", "movies": "movies/ntsc" in cert["files"],
            "digest": digest, "disc_id": (cert.get("xbe_md5", "") or "0" * 12)[:12] + digest[:8], "fake": cert.get("fake", {})}


def check_xml2(folder):
    folder = pathlib.Path(folder)
    exe = folder / "XMen2.exe"
    if not exe.is_file():
        raise Failure(3, "E_XML2_NOT_FOUND", "X-Men Legends II was not found in the folder the launcher has for it.",
                      "Check X-Men Legends II's folder in the launcher (its page, Settings).", {"path": mask(folder)})
    if folder_bytes(folder) > REFUSE_BYTES:
        raise Failure(2, "E_USAGE", "The fake builder only works on small test folders, never on a real install.", "", {})
    if not (folder / "Data" / "herostat.engb").is_file():
        raise Failure(3, "E_XML2_LANGUAGE", "This X-Men Legends II install is not the English version.",
                      "The port needs the English PC version of X-Men Legends II.", {})
    files = [p for p in folder.rglob("*") if p.is_file() and not is_proxy(p.relative_to(folder))]
    digest = hashlib.sha1()
    for file in sorted(files):
        digest.update(file.relative_to(folder).as_posix().encode() + str(file.stat().st_size).encode())
    return {"path": mask(folder), "exe_known": True, "exe_md5": hashlib.md5(exe.read_bytes()).hexdigest(), "language": "ENG",
            "base_files": len(files), "base_digest": digest.hexdigest(), "modified": []}


def is_proxy(rel):
    parts = pathlib.PurePath(rel).parts
    if not parts:
        return False
    name = parts[0].lower()
    return (len(parts) == 1 and (name in PROXY_NAMES or name.startswith(PROXY_PREFIXES))) or name == "mods"


def check_out(out, xml2=None, cache=None):
    out = pathlib.Path(out).resolve()
    for other, label in ((xml2, "X-Men Legends II"), (cache, "the build cache")):
        if other:
            other = pathlib.Path(other).resolve()
            if out == other or other in out.parents or out in other.parents:
                raise Failure(2, "E_OUT_UNSAFE", f"The game can't be built inside {label}'s folder.",
                              "Choose a separate folder for X-Men Legends.", {"out": mask(out), "conflict": mask(other)})
    if out.exists() and not out.is_dir():
        raise Failure(2, "E_OUT_FOREIGN", "The destination is a file.", "Choose a folder.", {"out": mask(out)})
    if out.exists() and any(out.iterdir()) and not builder_folder(out):
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


def write_json(path, data):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.tmp{os.getpid()}")
    temp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(temp, path)


def out_state(out, version, iso=None, xml2=None):
    """-> (state, reasons, stamp) per section 2.7 (without 'damaged', which is verify's)."""
    out = pathlib.Path(out)
    if not out.exists() or not any(out.iterdir()):
        return "absent", [], None
    if not builder_folder(out):
        return "foreign", ["files but no builder _build folder"], None
    stamp = read_json(out / "_build" / "stamp.json")
    if (out / "_build" / "building.json").is_file() or not stamp:
        return "incomplete", ["a build was started and did not finish"], stamp
    reasons = []
    if stamp.get("builder", {}).get("content_version", 0) < version["content_version"]:
        reasons.append(f"content version {stamp['builder'].get('content_version')} < {version['content_version']}")
    wanted = dict(PROFILE, movies=stamp.get("profile", {}).get("movies", True))
    if stamp.get("profile") != wanted:
        reasons.append("the build profile changed")
    if iso and stamp.get("inputs", {}).get("disc", {}).get("digest") != iso.get("digest"):
        reasons.append("a different disc image")
    if xml2 and stamp.get("inputs", {}).get("xml2", {}).get("base_digest") != xml2.get("base_digest"):
        reasons.append("X-Men Legends II changed")
    return ("stale" if reasons else "current"), reasons, stamp


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
# commands

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
    return pathlib.Path(os.path.splitdrive(str(pathlib.Path(path).resolve()))[0] + "\\")


def cache_bytes(cache):
    return folder_bytes(cache) if cache and pathlib.Path(cache).exists() else 0


def space_report(iso, out, cache, movies=True):
    need_out = int(iso.get("fake", {}).get("need_bytes", 0)) or (4_200_000_000 if movies else 3_100_000_000)
    need_cache = int(iso.get("fake", {}).get("cache_need_bytes", 0)) or 2_800_000_000
    report = {}
    if out:
        present = folder_bytes(out) if pathlib.Path(out).exists() else 0
        want = max(0, int((need_out - present) * 1.1))
        report["out"] = {"volume": str(volume(out)), "need": want, "free": free_bytes(out)}
        report["out"]["ok"] = report["out"]["free"] >= want
    if cache:
        disc_cache = pathlib.Path(cache) / iso["disc_id"]
        want = max(0, need_cache - cache_bytes(disc_cache))
        report["cache"] = {"volume": str(volume(cache)), "need": want, "free": free_bytes(cache)}
        report["cache"]["ok"] = report["cache"]["free"] >= want
        if out and report["cache"]["volume"].lower() == report["out"]["volume"].lower():
            both = report["out"]["need"] + want
            report["out"]["ok"] = report["cache"]["ok"] = report["out"]["free"] >= both
    return report


def cached_stages(cache, iso):
    if not cache or not iso:
        return set()
    prepared = pathlib.Path(cache) / iso["disc_id"] / "prepared"
    return {s[0] for s in STAGES if s[3] and (prepared / f"{s[0]}.json").is_file()}


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
        if args.cache:
            disc_cache = pathlib.Path(args.cache) / iso["disc_id"] if iso else None
            stamp_disc = (info.get("out", {}).get("stamp") or {}).get("inputs", {}).get("disc", {}).get("disc_id")
            if not disc_cache and stamp_disc:
                disc_cache = pathlib.Path(args.cache) / stamp_disc
            info["cache"] = {"path": mask(args.cache), "bytes": cache_bytes(args.cache),
                             "disc_bytes": cache_bytes(disc_cache) if disc_cache else 0,
                             "stages": sorted(cached_stages(args.cache, iso or ({"disc_id": stamp_disc} if stamp_disc else None)))}
        if iso:
            info["space"] = space_report(iso, args.out, args.cache)
            cores = os.cpu_count() or 4
            cached = cached_stages(args.cache, iso)
            first = int(360 + 450 * 4 / min(cores, 16))
            info["estimate"] = {"cores": cores, "first_build_s": first if not cached else 300, "rebuild_s": 300}
    except Failure as f:
        failure = f
    if failure:
        out.event("error", stage="probe", code=failure.code, msg=failure.msg, hint=failure.hint, detail=failure.detail)
        exit_code = failure.exit_code
    out.event("result", ok=exit_code == 0, exit=exit_code, info=info)
    return exit_code


def cmd_verify(args, out, version):
    target = pathlib.Path(args.out)
    iso = identify_iso(args.iso) if args.iso and pathlib.Path(args.iso).is_file() else None
    xml2 = check_xml2(args.xml2) if args.xml2 else None
    state, reasons, stamp = out_state(target, version, iso, xml2)
    checked = 0
    if state in ("current", "stale"):
        registry = read_json(target / "_build" / "registry.json", {"files": []})
        base = read_json(target / "_build" / "base_manifest.json", {"files": []})
        for entry in registry["files"] + base["files"]:
            path = target / entry["path"]
            checked += 1
            if not path.is_file():
                reasons.append(f"missing: {entry['path']}")
            elif hashlib.sha1(path.read_bytes()).hexdigest() != entry["sha1"]:
                reasons.append(f"changed: {entry['path']}")
        if any(r.startswith(("missing:", "changed:")) for r in reasons):
            state = "damaged"
    out.human(f"verify: {state} ({checked} files checked)")
    out.event("result", ok=True, exit=0, verify={"state": state, "reasons": reasons, "files": checked, "stamp": stamp})
    return 0


def remove_empty_dirs(root):
    for folder in sorted((p for p in pathlib.Path(root).rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            folder.rmdir()
        except OSError:
            pass


def cmd_clean(args, out, version):
    result = {"files": 0, "bytes": 0, "kept": [], "cache_bytes": 0, "dry_run": bool(args.dry_run)}
    if args.out:
        target = pathlib.Path(args.out)
        if target.exists():
            if not builder_folder(target):
                raise Failure(2, "E_OUT_FOREIGN", "This folder was not made by the builder, so it deletes nothing in it.",
                              "Delete the folder yourself if you no longer need it.", {"out": mask(target)})
            stamp = read_json(target / "_build" / "stamp.json") or read_json(target / "_build" / "building.json") or {}
            registry = read_json(target / "_build" / "registry.json", {"files": []})
            base = read_json(target / "_build" / "base_manifest.json", {"files": []})
            for entry in registry["files"] + base["files"]:
                path = target / entry["path"]
                if path.is_file() and not is_proxy(pathlib.PurePath(entry["path"])):
                    result["files"] += 1
                    result["bytes"] += path.stat().st_size
                    if not args.dry_run:
                        path.unlink()
            if args.mods and (target / "mods").exists():
                result["files"] += sum(1 for p in (target / "mods").rglob("*") if p.is_file())
                if not args.dry_run:
                    shutil.rmtree(target / "mods")
            if not args.dry_run:
                shutil.rmtree(target / "_build", ignore_errors=True)
                remove_empty_dirs(target)
            result["kept"] = sorted(p.name for p in target.iterdir()) if target.exists() else []
            if not args.dry_run and target.exists() and not any(target.iterdir()):
                target.rmdir()
            disc_id = stamp.get("inputs", {}).get("disc", {}).get("disc_id")
        else:
            disc_id = None
        if args.cache:
            cache = pathlib.Path(args.cache) / disc_id if disc_id else None
            if cache and cache.exists():
                result["cache_bytes"] = cache_bytes(cache)
                if not args.dry_run:
                    shutil.rmtree(cache)
    elif args.cache:
        cache = pathlib.Path(args.cache)
        if cache.exists():
            for child in cache.iterdir():
                if child.is_dir() and (child / "disc.json").is_file():
                    result["cache_bytes"] += cache_bytes(child)
                    if not args.dry_run:
                        shutil.rmtree(child)
    else:
        raise Failure(2, "E_USAGE", "clean needs --out or --cache.", "", {})
    out.human(f"clean: {result['files']} files, {result['bytes']} bytes; cache {result['cache_bytes']} bytes")
    out.event("result", ok=True, exit=0, clean=result)
    return 0


def cmd_build(args, out, version, cancel):
    for name in ("iso", "xml2", "out"):
        if not getattr(args, name):
            raise Failure(2, "E_USAGE", f"build needs --{name}.", "", {})
    iso = identify_iso(args.iso)
    fake = iso["fake"]
    cancel.ignore = bool(fake.get("ignore_cancel"))
    speed = float(fake.get("speed", 1.0))
    xml2 = check_xml2(args.xml2)
    target = check_out(args.out, args.xml2, args.cache)
    movies = not args.no_movies
    space = space_report(iso, target, args.cache, movies)
    for where in ("out", "cache"):
        if where in space and not space[where]["ok"]:
            raise Failure(4, "E_SPACE", f"Not enough free space on {space[where]['volume']}.",
                          "Free up some space or choose another folder.", space[where])

    build = target / "_build"
    build.mkdir(parents=True, exist_ok=True)
    lock = build / "lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            holder = int(lock.read_text().strip() or 0)
        except (OSError, ValueError):
            holder = 0
        if holder and pid_alive(holder):
            raise Failure(2, "E_OUT_LOCKED", "Another build is writing to this folder.", "Wait for it to finish.", {"pid": holder})
        lock.unlink(missing_ok=True)
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    try:
        out.open_log(build / "builder.log")
        out.human(f"xml1-builder {version['version']} (fake) build: iso={mask(args.iso)} xml2={mask(args.xml2)} out={mask(target)}")
        return run_build(args, out, version, cancel, iso, xml2, target, movies, speed, fake)
    finally:
        lock.unlink(missing_ok=True)


def pid_alive(pid):
    import ctypes
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(handle)
    return code.value == 259  # STILL_ACTIVE


def run_build(args, out, version, cancel, iso, xml2, target, movies, speed, fake):
    build = target / "_build"
    started = time.monotonic()
    write_json(build / "building.json", {"started": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                                         "builder": version, "inputs": {"disc": {"disc_id": iso["disc_id"]}}})
    cache = pathlib.Path(args.cache) if args.cache else None
    prepared = cache / iso["disc_id"] / "prepared" if cache else None
    cached = cached_stages(cache, iso)
    plan = [{"id": s[0], "title": s[1], "weight": s[2], "cached": s[0] in cached} for s in STAGES]
    out.event("plan", stages=plan)
    total_weight = sum(0.1 if p["cached"] else p["weight"] for p in plan)
    done_weight = 0.0
    registry = []
    base = []
    warnings = int(fake.get("warnings", 204))

    def unit_time(stage_weight, count):
        return 0.12 * stage_weight * speed / max(count, 1)

    for stage_id, title, weight, is_cache, unit, count in STAGES:
        cancel.check()
        is_cached = stage_id in cached
        stage_weight = 0.1 if is_cached else weight
        CURRENT["stage"] = stage_id
        out.event("stage", id=stage_id, state="start")
        stage_start = time.monotonic()
        if stage_id == "sync":
            files = [p for p in pathlib.Path(args.xml2).rglob("*") if p.is_file() and not is_proxy(p.relative_to(args.xml2))]
            count = len(files)
        steps = 1 if is_cached else max(count, 1)
        # Fewer, bigger steps for the made-up counts; every step is a cancel checkpoint.
        chunks = min(steps, 20)
        for chunk in range(chunks):
            cancel.check()
            if stage_id == fake.get("fail_stage") and chunk == chunks // 2:
                raise Failure(1, "E_PIPELINE", f"This step of the build failed: {title}.", "This is a bug in the builder: please report it.",
                              {"module": stage_id}, stage_id)
            if stage_id == fake.get("io_error_stage") and chunk == chunks // 2:
                raise Failure(6, "E_IO", f"Could not write to {mask(target)} (the file is in use).",
                              "Close X-Men Legends if it is running, then try again.", {"path": mask(target)}, stage_id)
            if stage_id == fake.get("crash_stage") and chunk == chunks // 2:
                raise RuntimeError(f"fake crash in {stage_id}")
            if not is_cached:
                time.sleep(unit_time(weight, chunks))
            done_units = int(steps * (chunk + 1) / chunks)
            frac = (chunk + 1) / chunks
            overall = 100.0 * (done_weight + stage_weight * frac) / total_weight
            elapsed = time.monotonic() - started
            eta = elapsed / max(overall, 0.1) * (100 - overall)
            out.progress(stage_id, done_units, steps, unit, overall, eta)

        if stage_id == "sync":
            for file in files:
                cancel.check()
                rel = file.relative_to(args.xml2).as_posix()
                dest = target / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists() or dest.stat().st_size != file.stat().st_size:
                    temp = dest.with_name(dest.name + f".tmp{os.getpid()}")
                    shutil.copy2(file, temp)
                    os.replace(temp, dest)
                base.append({"path": rel, "size": dest.stat().st_size, "sha1": hashlib.sha1(dest.read_bytes()).hexdigest()})
        elif stage_id == "content":
            for rel in CONTENT_FILES + (MOVIE_FILES if movies else []):
                cancel.check()
                dest = target / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                text = f"fake X-Men Legends port file {rel} (content {version['content_version']}); no game data\n"
                dest.write_text(text, encoding="utf-8")
                registry.append({"path": rel, "size": dest.stat().st_size, "sha1": hashlib.sha1(dest.read_bytes()).hexdigest()})
        elif stage_id == "sweep":
            previous = read_json(build / "registry.json", {"files": []})
            keep = {e["path"] for e in registry} | {e["path"] for e in base}
            for entry in previous["files"]:
                if entry["path"] not in keep and not is_proxy(pathlib.PurePath(entry["path"])):
                    (target / entry["path"]).unlink(missing_ok=True)
            remove_empty_dirs(target)
            write_json(build / "registry.json", {"files": registry})
            write_json(build / "base_manifest.json", {"files": base})
        elif stage_id == "validate":
            out.event("log", level="info", stage="validate", msg=f"{len(registry)} files checked, 0 errors")
            if fake.get("validate_errors"):
                raise Failure(1, "E_VALIDATE", "The finished build did not pass its checks.",
                              "This is a bug in the builder: please report it.", {"errors": int(fake["validate_errors"])}, stage_id)
        elif stage_id == "finish":
            if not args.no_ini:
                merge_ini(target / "xml2-fix.ini", PORT_INI)
        if is_cache and not is_cached and prepared:
            write_json(prepared / f"{stage_id}.json", {"stage": stage_id, "version": 1, "inputs_digest": iso["digest"]})
            write_json(cache / iso["disc_id"] / "disc.json", {"disc_id": iso["disc_id"], "title": iso["title"]})
        if stage_id in ("content", "validate"):
            out.event("warning", stage=stage_id, code="W_PIPELINE", msg=f"{warnings // 2} warnings (details in report.json)", count=warnings // 2)
        out.event("stage", id=stage_id, state="done", seconds=round(time.monotonic() - stage_start, 2))
        done_weight += stage_weight

    seconds = round(time.monotonic() - started, 1)
    report = {"errors": 0, "warnings": warnings, "seconds": seconds, "files": len(registry)}
    write_json(build / "report.json", report)
    stamp = {
        "format": 1,
        "builder": {"version": version["version"], "commit": version["commit"], "content_version": version["content_version"]},
        "profile": dict(PROFILE, movies=movies),
        "inputs": {"disc": {"format": iso["format"], "title_id": iso["title_id"], "xbe_md5": iso["xbe_md5"],
                            "digest": iso["digest"], "disc_id": iso["disc_id"], "known": iso["dump"] or False},
                   "xml2": {"exe_md5": xml2["exe_md5"], "base_digest": xml2["base_digest"], "base_files": xml2["base_files"],
                            "modified": []}},
        "requires": {"xml2fix": ">=1.2.0", "ini": PORT_INI},
        "outputs": {"files": len(registry), "bytes": sum(e["size"] for e in registry),
                    "registry_sha1": hashlib.sha1(json.dumps(registry, sort_keys=True).encode()).hexdigest()},
        "result": {"errors": 0, "warnings": warnings, "seconds": seconds},
        "finished": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    write_json(build / "stamp.json", stamp)
    (build / "building.json").unlink(missing_ok=True)
    if args.drop_cache and cache and (cache / iso["disc_id"]).exists():
        shutil.rmtree(cache / iso["disc_id"])
    out.human(f"build finished in {seconds} s: {len(registry)} files, {warnings} warnings")
    out.event("result", ok=True, exit=0, out=mask(target), report=mask(build / "report.json"), log=mask(build / "builder.log"),
              errors=0, warnings=warnings, stamp=stamp, seconds=seconds)
    return 0


# ---------------------------------------------------------------------------------------------

def parse(argv):
    parser = argparse.ArgumentParser(prog="xml1-builder", add_help=True)
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--events", choices=["jsonl"])
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
        out.event("error", stage="probe", code="E_USAGE", msg="No command given.", hint="", detail={})
        out.event("result", ok=False, exit=2)
        return 2
    if not args.log and args.cache and args.command == "build":
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        out.open_log(pathlib.Path(args.cache) / "logs" / f"builder-{stamp}.log", rotate=False)
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
        out.human("cancelled")
        out.event("result", ok=False, exit=5)
        return 5
    except Failure as f:
        out.event("error", stage=f.stage or "probe", code=f.code, msg=f.msg, hint=f.hint, detail=f.detail)
        out.event("result", ok=False, exit=f.exit_code)
        return f.exit_code
    except Exception as e:  # noqa: BLE001 - the builder's own "internal error"
        import traceback
        out.human(traceback.format_exc())
        out.event("error", stage=CURRENT["stage"], code="E_INTERNAL", msg=f"Internal error: {e}", hint="Please report this, with the log.", detail={})
        out.event("result", ok=False, exit=70)
        return 70


if __name__ == "__main__":
    sys.exit(main())
