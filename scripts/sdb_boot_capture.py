#!/usr/bin/env python3
"""Captures the TV's dlog while (re)launching the app: one SDB connection with
two streams — dlog: for the system log and shell: for the launch commands.

    python scripts/sdb_boot_capture.py 192.168.1.77 [seconds]

Shows what the launcher, web engine and app print during boot: JS console
messages, exceptions, crash traces and package errors.
"""
import re
import sys
import time

from sdb_install import Sdb


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.77"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
    app_pkg = "NuvioTV001"
    app_id = "NuvioTV001.NuvioTV"

    sdb = Sdb(ip)
    print("Connected: %s" % sdb.banner, flush=True)

    try:
        dlog = sdb.open("dlog:")
        print("servicio dlog: abierto", flush=True)
    except ConnectionError:
        dlog = None
        print("servicio dlog: RECHAZADO (solo shell)", flush=True)

    shell = sdb.open("shell:")
    print("servicio shell: abierto", flush=True)

    def shell_cmd(command, until, wait):
        sdb.write(shell, command.encode() + b"\0")
        out = sdb.read_until(shell, lambda t: bool(until and re.search(until, t.decode("utf-8", "replace"))), wait)
        return out.decode("utf-8", "replace")

    # Ensure a clean start so boot messages are ours.
    print("--- kill previo ---", flush=True)
    print(shell_cmd("0 kill " + app_pkg, r"spend time", 30).strip(), flush=True)
    time.sleep(1)

    launched_at = time.time()
    print("--- lanzar ---", flush=True)
    print(shell_cmd("0 was_execute " + app_id, r"launched|spend time", 30).strip(), flush=True)

    # Pump everything until the window ends, draining dlog as it arrives.
    end = launched_at + seconds
    while time.time() < end:
        sdb.sock.settimeout(max(0.1, end - time.time()))
        try:
            sdb.pump()
        except Exception:
            break
        if dlog is not None and sdb.inbox.get(dlog[0]):
            chunk = sdb.inbox.pop(dlog[0])
            sys.stdout.write(chunk.decode("utf-8", "replace"))
            sys.stdout.flush()
    print("\n--- fin de captura (%.0fs) ---" % seconds)


if __name__ == "__main__":
    main()
