#!/usr/bin/env python3
"""Runs one SDB shell command on the TV and prints the answer.

    python scripts/sdb_cmd.py 192.168.1.77 "0 applist"
    python scripts/sdb_cmd.py 192.168.1.77 "0 debug NuvioTV001.NuvioTV 300"

Reuses the Sdb class from sdb_install.py (protocol adapted from Free My TV,
github.com/simbasjungles/free-my-tv, GPL-3.0).
"""
import sys

from sdb_install import Sdb


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    ip, command = sys.argv[1], sys.argv[2]
    seconds = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    sdb = Sdb(ip)
    print("Connected: %s" % sdb.banner)
    out = sdb.shell(command, r"spend time", seconds)
    print(out.strip() or "(sin salida)")


if __name__ == "__main__":
    main()
