#!/usr/bin/env python3
"""
adapos_probe.py  —  AdaPos HyperMart window & data detection diagnostic
=========================================================================
Run this on FRONT2 while AdaPos HyperMart 4.6006.30 is open (ideally at
the checkout/payment screen so the total is visible).

What it tests
─────────────
  1. Win32 window enumeration  — pure ctypes, no extra packages
  2. Windows UI Automation     — reads control text directly from AdaPos
     (via pywinauto / uiautomation, degrades gracefully if not installed)
  3. Screenshot capture        — grabs the AdaPos window as a PNG
     (via Pillow, degrades gracefully)
  4. Local database search     — looks for Access/SQLite/MSSQL files that
     AdaPos might use

Results are written to adapos_probe_results.txt in the same folder.

Install helper packages (optional but recommended):
    pip install pywinauto pillow pygetwindow uiautomation
"""

import ctypes
import ctypes.wintypes as wt
import os
import pathlib
import sys
import traceback
from datetime import datetime

# ── output collector ────────────────────────────────────────────────────────

_lines = []

def log(msg=""):
    _lines.append(msg)
    print(msg)


# ── Win32 helpers (pure ctypes) ─────────────────────────────────────────────

user32   = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

def _get_window_text(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value

def _get_class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value

def _get_pid(hwnd):
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value

def _get_process_name(pid):
    try:
        import subprocess
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            if str(pid) in line:
                return line.split(",")[0].strip('"')
    except Exception:
        pass
    return f"PID:{pid}"

def enumerate_windows():
    """Return list of (hwnd, title, class_name, pid) for all visible top-level windows."""
    windows = []
    def callback(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            title = _get_window_text(hwnd)
            cls   = _get_class_name(hwnd)
            pid   = _get_pid(hwnd)
            if title:
                windows.append((hwnd, title, cls, pid))
        return True
    user32.EnumWindows(EnumWindowsProc(callback), 0)
    return windows


def _child_texts(hwnd):
    """Collect text from direct child controls (Win32 WM_GETTEXT)."""
    texts = []
    ChildProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def child_cb(child_hwnd, _):
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(child_hwnd, buf, 512)
        val = buf.value.strip()
        if val:
            cls = _get_class_name(child_hwnd)
            texts.append((cls, val))
        return True
    user32.EnumChildWindows(hwnd, ChildProc(child_cb), 0)
    return texts


# ── Section 1: window search ────────────────────────────────────────────────

SEARCH_TERMS = [
    "adapos", "hypermart", "hyper mart", "adas", "pos", "cashier",
    "checkout", "payment", "ชำระ", "ขาย", "แคชเชียร์",
]

def section_window_search():
    log("=" * 70)
    log("SECTION 1 — Win32 window enumeration (pure ctypes)")
    log("=" * 70)

    all_windows = enumerate_windows()
    log(f"Total visible top-level windows: {len(all_windows)}")
    log()

    matches = []
    for hwnd, title, cls, pid in all_windows:
        low = title.lower()
        if any(term in low for term in SEARCH_TERMS):
            matches.append((hwnd, title, cls, pid))

    if not matches:
        log("⚠  No windows matched AdaPos search terms.")
        log("   Make sure AdaPos HyperMart is running and visible.")
        log()
        log("All visible windows (for manual inspection):")
        for hwnd, title, cls, pid in all_windows:
            log(f"  [{hwnd:>10}]  {title:<55}  class={cls}")
        return []

    log(f"✓  Found {len(matches)} potential AdaPos window(s):")
    log()
    for hwnd, title, cls, pid in matches:
        proc = _get_process_name(pid)
        log(f"  HWND   : {hwnd}")
        log(f"  Title  : {title}")
        log(f"  Class  : {cls}")
        log(f"  Process: {proc}  (PID {pid})")
        log()

        child_texts = _child_texts(hwnd)
        if child_texts:
            log(f"  Child control texts ({len(child_texts)} found):")
            for c_cls, c_val in child_texts:
                log(f"    [{c_cls}]  {c_val!r}")
        else:
            log("  Child control texts: (none via Win32 WM_GETTEXT — likely custom rendering)")
        log()

    return matches


# ── Section 2: UI Automation via pywinauto ──────────────────────────────────

def section_uia_pywinauto(matches):
    log("=" * 70)
    log("SECTION 2 — Windows UI Automation (pywinauto)")
    log("=" * 70)

    try:
        from pywinauto import Desktop, Application
        from pywinauto.findwindows import ElementNotFoundError
    except ImportError:
        log("⚠  pywinauto not installed.  Run: pip install pywinauto")
        log()
        return

    if not matches:
        log("⚠  No target window from Section 1 — skipping.")
        log()
        return

    for hwnd, title, cls, pid in matches:
        log(f"Probing HWND {hwnd}: {title!r}")
        try:
            app = Application(backend="uia").connect(handle=hwnd)
            win = app.window(handle=hwnd)
            log("  Backend: UIA")
            _dump_uia_tree(win, indent=2)
        except Exception as e:
            log(f"  UIA failed: {e}")
            try:
                app = Application(backend="win32").connect(handle=hwnd)
                win = app.window(handle=hwnd)
                log("  Backend: Win32")
                _dump_uia_tree(win, indent=2)
            except Exception as e2:
                log(f"  Win32 also failed: {e2}")
        log()


def _dump_uia_tree(ctrl, indent=0, depth=0, max_depth=6):
    if depth > max_depth:
        return
    try:
        texts = []
        try: texts.append(ctrl.window_text())
        except: pass
        try: texts.append(str(ctrl.legacy_properties().get("Value", "")))
        except: pass
        label = " | ".join(t for t in texts if t.strip())
        ctrl_type = ""
        try: ctrl_type = ctrl.element_info.control_type
        except: pass
        if label or ctrl_type:
            log(" " * indent + f"[{ctrl_type}] {label!r}")
    except Exception:
        pass
    try:
        for child in ctrl.children():
            _dump_uia_tree(child, indent + 2, depth + 1, max_depth)
    except Exception:
        pass


# ── Section 3: uiautomation library ─────────────────────────────────────────

def section_uia_lib(matches):
    log("=" * 70)
    log("SECTION 3 — Windows UI Automation (uiautomation library)")
    log("=" * 70)

    try:
        import uiautomation as auto
    except ImportError:
        log("⚠  uiautomation not installed.  Run: pip install uiautomation")
        log()
        return

    if not matches:
        log("⚠  No target window from Section 1 — skipping.")
        log()
        return

    for hwnd, title, cls, pid in matches:
        log(f"Probing HWND {hwnd}: {title!r}")
        try:
            win = auto.ControlFromHandle(hwnd)
            if win:
                log(f"  Name: {win.Name!r}")
                log(f"  ControlType: {win.ControlTypeName}")
                _dump_auto_tree(win, indent=4)
            else:
                log("  Could not get control from handle")
        except Exception as e:
            log(f"  Error: {e}")
        log()


def _dump_auto_tree(ctrl, indent=0, depth=0, max_depth=6):
    if depth > max_depth:
        return
    try:
        name  = (ctrl.Name or "").strip()
        value = ""
        try: value = ctrl.GetValuePattern().Value
        except: pass
        ctype = ctrl.ControlTypeName
        if name or value:
            log(" " * indent + f"[{ctype}] name={name!r}  value={value!r}")
        child = ctrl.GetFirstChildControl()
        while child:
            _dump_auto_tree(child, indent + 2, depth + 1, max_depth)
            child = child.GetNextSiblingControl()
    except Exception:
        pass


# ── Section 4: Screenshot ────────────────────────────────────────────────────

def section_screenshot(matches):
    log("=" * 70)
    log("SECTION 4 — Screenshot capture")
    log("=" * 70)

    try:
        from PIL import ImageGrab
        import PIL
    except ImportError:
        log("⚠  Pillow not installed.  Run: pip install pillow")
        log()
        return

    if not matches:
        log("⚠  No target window — taking full screen screenshot instead.")
        try:
            img = ImageGrab.grab()
            out = pathlib.Path(__file__).parent / "adapos_probe_fullscreen.png"
            img.save(str(out))
            log(f"  Saved: {out}")
        except Exception as e:
            log(f"  Error: {e}")
        log()
        return

    for hwnd, title, cls, pid in matches:
        log(f"Capturing HWND {hwnd}: {title!r}")
        try:
            # Get window rect
            rect = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            bbox = (rect.left, rect.top, rect.right, rect.bottom)
            w = rect.right - rect.left
            h = rect.bottom - rect.top
            log(f"  Window rect: left={rect.left} top={rect.top} w={w} h={h}")

            if w > 0 and h > 0:
                img = ImageGrab.grab(bbox)
                safe_title = "".join(c if c.isalnum() else "_" for c in title[:30])
                out = pathlib.Path(__file__).parent / f"adapos_probe_{safe_title}.png"
                img.save(str(out))
                log(f"  ✓ Saved screenshot: {out}")
            else:
                log("  Window has zero size (minimised?)")
        except Exception as e:
            log(f"  Error: {e}")
            traceback.print_exc()
        log()


# ── Section 5: PrintWindow capture (works even when window is behind others) ─

def section_printwindow(matches):
    log("=" * 70)
    log("SECTION 5 — PrintWindow capture (off-screen / occluded windows)")
    log("=" * 70)

    try:
        from PIL import Image
        import ctypes
    except ImportError:
        log("⚠  Pillow not installed — skipping.")
        log()
        return

    if not matches:
        log("  No target window — skipping.")
        log()
        return

    GDI32 = ctypes.windll.gdi32

    for hwnd, title, cls, pid in matches:
        log(f"PrintWindow HWND {hwnd}: {title!r}")
        try:
            rect = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = rect.right  - rect.left
            h = rect.bottom - rect.top
            if w <= 0 or h <= 0:
                log("  Zero-size window — skipped.")
                continue

            hdc_win  = user32.GetDC(hwnd)
            hdc_mem  = GDI32.CreateCompatibleDC(hdc_win)
            hbm      = GDI32.CreateCompatibleBitmap(hdc_win, w, h)
            GDI32.SelectObject(hdc_mem, hbm)

            # PW_RENDERFULLCONTENT = 0x00000002 (works on Win8.1+)
            user32.PrintWindow(hwnd, hdc_mem, 2)

            # Convert HBITMAP → PIL Image via DIB
            import struct
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

            bmi = BITMAPINFOHEADER()
            bmi.biSize      = ctypes.sizeof(BITMAPINFOHEADER)
            bmi.biWidth     = w
            bmi.biHeight    = -h  # top-down
            bmi.biPlanes    = 1
            bmi.biBitCount  = 32
            bmi.biCompression = 0  # BI_RGB

            buf = (ctypes.c_char * (w * h * 4))()
            GDI32.GetDIBits(hdc_mem, hbm, 0, h, buf, ctypes.byref(bmi), 0)

            from PIL import Image as PILImage
            img = PILImage.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1)
            safe = "".join(c if c.isalnum() else "_" for c in title[:30])
            out  = pathlib.Path(__file__).parent / f"adapos_pw_{safe}.png"
            img.save(str(out))
            log(f"  ✓ Saved: {out}")

            GDI32.DeleteObject(hbm)
            GDI32.DeleteDC(hdc_mem)
            user32.ReleaseDC(hwnd, hdc_win)

        except Exception as e:
            log(f"  Error: {e}")
        log()


# ── Section 6: Database file search ─────────────────────────────────────────

DB_EXTENSIONS = {
    ".mdb":    "Microsoft Access",
    ".accdb":  "Microsoft Access",
    ".sqlite": "SQLite",
    ".sqlite3":"SQLite",
    ".db":     "SQLite / generic",
    ".sdf":    "SQL Server Compact",
    ".ldf":    "SQL Server log",
    ".mdf":    "SQL Server data",
    ".fdb":    "Firebird",
    ".gdb":    "Firebird",
}

SEARCH_ROOTS = [
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\AdaPos",
    r"C:\HyperMart",
    r"C:\POS",
    r"C:\POSDATA",
    r"C:\Users\Administrator",
    r"C:\Users\Public",
    r"C:\ProgramData",
    r"D:\\",
]

def section_db_search():
    log("=" * 70)
    log("SECTION 6 — Local database file search")
    log("=" * 70)

    found = []
    for root in SEARCH_ROOTS:
        if not os.path.isdir(root):
            continue
        log(f"Searching: {root}")
        try:
            for dirpath, dirnames, filenames in os.walk(root):
                # Skip system / deep noise folders
                dirnames[:] = [d for d in dirnames if d.lower() not in
                               {"windows", "winsxs", "assembly", "drivers",
                                "microsoft.net", "$recycle.bin", "temp"}]
                for fname in filenames:
                    ext = pathlib.Path(fname).suffix.lower()
                    if ext in DB_EXTENSIONS:
                        full = os.path.join(dirpath, fname)
                        try:
                            size = os.path.getsize(full)
                            mtime = datetime.fromtimestamp(os.path.getmtime(full))
                        except Exception:
                            size, mtime = -1, None
                        found.append((full, ext, size, mtime))
        except PermissionError:
            pass
        except Exception as e:
            log(f"  Walk error in {root}: {e}")

    if found:
        log()
        log(f"Found {len(found)} database file(s):")
        for fpath, ext, size, mtime in sorted(found, key=lambda x: -x[2]):
            size_kb = size / 1024
            mtime_str = mtime.strftime("%Y-%m-%d %H:%M") if mtime else "?"
            log(f"  [{DB_EXTENSIONS[ext]:<24}]  {size_kb:>10.1f} KB  {mtime_str}  {fpath}")
    else:
        log("  No database files found in searched locations.")

    log()


# ── Section 7: Registry check for AdaPos install path ───────────────────────

def section_registry():
    log("=" * 70)
    log("SECTION 7 — Registry: AdaPos install path")
    log("=" * 70)

    try:
        import winreg
    except ImportError:
        log("  winreg unavailable — skipping.")
        log()
        return

    search_keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\AdaPos"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\HyperMart"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\AdaPos"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\HyperMart"),
        (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\AdaPos"),
        (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\HyperMart"),
    ]

    any_found = False
    for hive, path in search_keys:
        try:
            with winreg.OpenKey(hive, path) as k:
                any_found = True
                log(f"  Key found: {path}")
                i = 0
                while True:
                    try:
                        name, data, _ = winreg.EnumValue(k, i)
                        log(f"    {name} = {data!r}")
                        i += 1
                    except OSError:
                        break
        except FileNotFoundError:
            pass
        except Exception as e:
            log(f"  Error reading {path}: {e}")

    # Also search uninstall keys for "AdaPos" or "HyperMart"
    for uninstall_root in [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ]:
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, uninstall_root) as root_k:
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(root_k, i)
                        i += 1
                        with winreg.OpenKey(root_k, sub) as sk:
                            try:
                                disp, _, _ = winreg.QueryValueEx(sk, "DisplayName")
                                if any(t in disp.lower() for t in ["adapos","hypermart","pos"]):
                                    any_found = True
                                    loc = ""
                                    try: loc, _, _ = winreg.QueryValueEx(sk, "InstallLocation")
                                    except: pass
                                    log(f"  Uninstall entry: {disp!r}  →  {loc!r}")
                            except FileNotFoundError:
                                pass
                    except OSError:
                        break
        except Exception:
            pass

    if not any_found:
        log("  No AdaPos / HyperMart registry entries found.")
    log()


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    log(f"adapos_probe.py — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"Python {sys.version}")
    log(f"Running on: {os.environ.get('COMPUTERNAME', 'unknown')}")
    log()

    matches = section_window_search()
    section_uia_pywinauto(matches)
    section_uia_lib(matches)
    section_screenshot(matches)
    section_printwindow(matches)
    section_db_search()
    section_registry()

    # Write results file
    out_path = pathlib.Path(__file__).parent / "adapos_probe_results.txt"
    out_path.write_text("\n".join(_lines), encoding="utf-8")
    print()
    print(f"Results saved to: {out_path}")


if __name__ == "__main__":
    main()
