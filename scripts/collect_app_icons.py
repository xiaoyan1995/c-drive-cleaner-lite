"""
collect_app_icons.py
====================
Extracts icons for ALL installed Windows software from the registry.
Output: resources/app-icons/<slug>.png  +  resources/app-icons/manifest.json

Requirements:
  pip install pywin32 Pillow icoextract
"""

import ctypes
import json
import os
import re
import sys
import winreg
from pathlib import Path

import io

# Fix Windows console encoding for Chinese output
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from PIL import Image
try:
    from icoextract import IconExtractor, IconExtractorError
    HAS_ICOEXTRACT = True
except ImportError:
    HAS_ICOEXTRACT = False

# ── output dir ────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
OUT_DIR = SCRIPT_DIR.parent / "resources" / "app-icons"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Windows icon extraction via ctypes ────────────────────────────────────────
class ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon",    ctypes.c_bool),
        ("xHotspot", ctypes.c_ulong),
        ("yHotspot", ctypes.c_ulong),
        ("hbmMask",  ctypes.c_void_p),
        ("hbmColor", ctypes.c_void_p),
    ]

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize",          ctypes.c_uint32),
        ("biWidth",         ctypes.c_int32),
        ("biHeight",        ctypes.c_int32),
        ("biPlanes",        ctypes.c_uint16),
        ("biBitCount",      ctypes.c_uint16),
        ("biCompression",   ctypes.c_uint32),
        ("biSizeImage",     ctypes.c_uint32),
        ("biXPelsPerMeter", ctypes.c_int32),
        ("biYPelsPerMeter", ctypes.c_int32),
        ("biClrUsed",       ctypes.c_uint32),
        ("biClrImportant",  ctypes.c_uint32),
    ]

user32   = ctypes.windll.user32
gdi32    = ctypes.windll.gdi32
shell32  = ctypes.windll.shell32
kernel32 = ctypes.windll.kernel32

SHGFI_ICON      = 0x000000100
SHGFI_LARGEICON = 0x000000000

class SHFILEINFO(ctypes.Structure):
    _fields_ = [
        ("hIcon",      ctypes.c_void_p),
        ("iIcon",      ctypes.c_int),
        ("dwAttributes", ctypes.c_ulong),
        ("szDisplayName", ctypes.c_wchar * 260),
        ("szTypeName",   ctypes.c_wchar * 80),
    ]


def hicon_to_pil(hicon) -> Image.Image | None:
    """Convert a Windows HICON handle to a PIL Image (RGBA, 64x64)."""
    if not hicon:
        return None
    try:
        info = ICONINFO()
        if not user32.GetIconInfo(hicon, ctypes.byref(info)):
            return None

        # Get bitmap dimensions
        bmp_header = BITMAPINFOHEADER()
        bmp_header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        if not gdi32.GetDIBits(gdi32.CreateCompatibleDC(None), info.hbmColor,
                               0, 0, None, ctypes.byref(bmp_header), 0):
            # Try querying header only
            pass

        w = bmp_header.biWidth or 32
        h = abs(bmp_header.biHeight) or 32

        hdc = gdi32.CreateCompatibleDC(None)
        buf_size = w * h * 4
        buf = (ctypes.c_byte * buf_size)()

        bmi = BITMAPINFOHEADER()
        bmi.biSize        = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.biWidth       = w
        bmi.biHeight      = -h   # top-down
        bmi.biPlanes      = 1
        bmi.biBitCount    = 32
        bmi.biCompression = 0    # BI_RGB

        gdi32.GetDIBits(hdc, info.hbmColor, 0, h, buf, ctypes.byref(bmi), 0)
        gdi32.DeleteDC(hdc)

        if info.hbmColor:  gdi32.DeleteObject(info.hbmColor)
        if info.hbmMask:   gdi32.DeleteObject(info.hbmMask)

        # buf is BGRA
        raw = bytes(buf)
        img = Image.frombytes("RGBA", (w, h), raw, "raw", "BGRA")
        # Scale to 64x64 for consistency
        img = img.resize((64, 64), Image.LANCZOS)
        return img
    except Exception:
        return None


def extract_icon_from_path(path: str, icon_index: int = 0) -> Image.Image | None:
    """Extract icon from an exe/dll/ico file.
    Priority: icoextract (PE resources) > .ico direct open > SHGetFileInfo > ExtractIconEx
    """
    if not os.path.exists(path):
        return None

    # .ico files: open directly
    if path.lower().endswith(".ico"):
        try:
            img = Image.open(path)
            # ICO files may have multiple sizes; pick largest
            sizes = getattr(img, "n_frames", 1)
            best = img
            for i in range(sizes):
                try:
                    img.seek(i)
                    if img.size[0] >= best.size[0]:
                        best = img.copy()
                except Exception:
                    break
            return best.convert("RGBA").resize((64, 64), Image.LANCZOS)
        except Exception:
            pass

    # icoextract: reads icon resources directly from PE binary (most accurate)
    if HAS_ICOEXTRACT and path.lower().endswith((".exe", ".dll")):
        try:
            extractor = IconExtractor(path)
            data = extractor.get_icon()          # returns BytesIO or bytes
            img = Image.open(data if hasattr(data, "read") else io.BytesIO(data))
            # Pick the largest frame in the ICO
            best = img.copy()
            for i in range(getattr(img, "n_frames", 1)):
                try:
                    img.seek(i)
                    if img.size[0] >= best.size[0]:
                        best = img.copy()
                except Exception:
                    break
            return best.convert("RGBA").resize((64, 64), Image.LANCZOS)
        except Exception:
            pass  # fall through to Shell API

    # Fallback: SHGetFileInfo (Shell API — may return wrong cached icon)
    try:
        sfi = SHFILEINFO()
        ret = shell32.SHGetFileInfoW(path, 0, ctypes.byref(sfi), ctypes.sizeof(sfi),
                                     SHGFI_ICON | SHGFI_LARGEICON)
        if ret and sfi.hIcon:
            img = hicon_to_pil(sfi.hIcon)
            user32.DestroyIcon(sfi.hIcon)
            if img:
                return img
    except Exception:
        pass

    # Last resort: ExtractIconEx
    try:
        hicon = ctypes.c_void_p(0)
        n = shell32.ExtractIconExW(path, icon_index, ctypes.byref(hicon), None, 1)
        if n > 0 and hicon:
            img = hicon_to_pil(hicon.value)
            user32.DestroyIcon(hicon)
            if img:
                return img
    except Exception:
        pass
    return None


# ── registry helpers ──────────────────────────────────────────────────────────
REG_UNINSTALL_PATHS = [
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
]

def read_all_apps():
    apps = {}
    for hive, path in REG_UNINSTALL_PATHS:
        try:
            key = winreg.OpenKey(hive, path)
        except OSError:
            continue
        i = 0
        while True:
            try:
                sub_name = winreg.EnumKey(key, i)
                i += 1
            except OSError:
                break
            try:
                sub = winreg.OpenKey(key, sub_name)
                def val(n):
                    try: return winreg.QueryValueEx(sub, n)[0]
                    except: return ""
                name    = val("DisplayName").strip()
                icon    = val("DisplayIcon").strip()
                install = val("InstallLocation").strip()
                winreg.CloseKey(sub)
                if name and name not in apps:
                    apps[name] = {"icon": icon, "install": install}
            except OSError:
                pass
        winreg.CloseKey(key)
    return apps


# ── slug helper ───────────────────────────────────────────────────────────────
def slugify(name: str) -> str:
    s = name.lower()
    s = re.sub(r'[^\w\u4e00-\u9fff\u3400-\u4dbf]+', '-', s)
    s = re.sub(r'-+', '-', s).strip('-')
    return s or "app"

SKIP_EXE_RE = re.compile(
    r'^(uninst|unins|uninstall|setup|install|update|updater|helper|crash|repair|redist)',
    re.I
)

def find_exe_in_dir(directory: str, prefer: str = "") -> str | None:
    if not os.path.isdir(directory):
        return None
    try:
        entries = os.listdir(directory)
    except OSError:
        return None
    exes = [f for f in entries if f.lower().endswith(".exe")]
    main_exes = [f for f in exes if not SKIP_EXE_RE.match(os.path.splitext(f)[0])]

    # Squirrel installer: only Update.exe at root, real app inside app-X.X.X/
    if not main_exes and exes:
        versioned_dirs = sorted(
            [d for d in entries if os.path.isdir(os.path.join(directory, d))
             and re.match(r'^app-\d', d)],
            reverse=True  # highest version first
        )
        for vd in versioned_dirs:
            result = find_exe_in_dir(os.path.join(directory, vd), prefer)
            if result:
                return result

    pool = main_exes or exes
    if not pool:
        return None
    if prefer:
        p = prefer.lower().replace(" ", "")
        for f in pool:
            stem = os.path.splitext(f)[0].lower().replace(" ", "")
            if p in stem or stem in p:
                return os.path.join(directory, f)
    # largest
    def sz(f):
        try: return os.path.getsize(os.path.join(directory, f))
        except: return 0
    pool.sort(key=sz, reverse=True)
    return os.path.join(directory, pool[0])


def resolve_icon_path(raw: str) -> str:
    return re.sub(r',\s*\d+\s*$', '', raw).strip('"\'').strip()


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    print("Reading registry...")
    apps = read_all_apps()
    print(f"  {len(apps)} installed apps found")

    manifest = {}   # slug -> display_name
    ok = 0
    fail = 0

    for display_name, info in sorted(apps.items()):
        slug = slugify(display_name)
        out_path = OUT_DIR / f"{slug}.png"
        if out_path.exists():
            manifest[slug] = display_name
            ok += 1
            continue

        icon_path = None

        # 1. DisplayIcon
        if info["icon"]:
            resolved = resolve_icon_path(info["icon"])
            if os.path.exists(resolved):
                icon_path = resolved

        # 2. Search InstallLocation
        if not icon_path and info["install"] and os.path.isdir(info["install"]):
            exe = find_exe_in_dir(info["install"], display_name)
            if exe:
                icon_path = exe
            else:
                # one level deep
                try:
                    for sub in os.listdir(info["install"]):
                        subdir = os.path.join(info["install"], sub)
                        exe = find_exe_in_dir(subdir, display_name)
                        if exe:
                            icon_path = exe
                            break
                except OSError:
                    pass

        if not icon_path:
            print(f"  [SKIP] {display_name} — no icon path")
            fail += 1
            continue

        img = extract_icon_from_path(icon_path)
        if img:
            try:
                img.save(str(out_path), "PNG")
                manifest[slug] = display_name
                ok += 1
                print(f"  [OK]   {display_name} -> {slug}.png")
            except Exception as e:
                print(f"  [ERR]  {display_name} -- save failed: {e}")
                fail += 1
        else:
            # Last resort: look for any .ico in the install dir
            ico_img = None
            if info["install"] and os.path.isdir(info["install"]):
                for f in os.listdir(info["install"]):
                    if f.lower().endswith(".ico"):
                        ico_path = os.path.join(info["install"], f)
                        ico_img = extract_icon_from_path(ico_path)
                        if ico_img:
                            break
            if ico_img:
                try:
                    ico_img.save(str(out_path), "PNG")
                    manifest[slug] = display_name
                    ok += 1
                    print(f"  [OK]   {display_name} -> {slug}.png (via .ico)")
                except Exception as e:
                    print(f"  [ERR]  {display_name} -- save failed: {e}")
                    fail += 1
            else:
                print(f"  [FAIL] {display_name} -- extraction failed ({icon_path})")
                fail += 1

    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8"
    )

    print(f"\nDone: {ok} saved, {fail} failed")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
