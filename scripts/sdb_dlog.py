#!/usr/bin/env python3
"""Reads the TV's system log (dlog) over SDB for a few seconds.

    python scripts/sdb_dlog.py 192.168.1.77 [seconds]

The dlog stream carries the launcher, web-engine and app messages: JS console
output, crash traces and package errors land here.
"""
import sys
import time

from sdb_install import Sdb

SERVICE_CANDIDATES = ["dlog:", "log:", "shell:dlog"]


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.77"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0

    sdb = Sdb(ip)
    print("Connected: %s" % sdb.banner, flush=True)

    stream = None
    for service in SERVICE_CANDIDATES:
        try:
            stream = sdb.open(service)
            print("servicio abierto: %s" % service, flush=True)
            break
        except ConnectionError:
            print("servicio rechazado: %s" % service, flush=True)
    if stream is None:
        sys.exit("ningun servicio de log aceptado")

    end = time.time() + seconds
    while time.time() < end:
        sdb.sock.settimeout(max(0.1, end - time.time()))
        try:
            sdb.pump()
        except Exception:
            break
        chunk = sdb.inbox.get(stream[0], b"")
        if chunk:
            del sdb.inbox[stream[0]]
            sys.stdout.write(chunk.decode("utf-8", "replace"))
            sys.stdout.flush()
    print("\n--- fin de captura ---")


if __name__ == "__main__":
    main()
