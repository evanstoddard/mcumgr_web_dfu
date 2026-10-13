#!/bin/sh
# ES modules don't load from file://; Web Serial needs a secure context (localhost counts).
cd "$(dirname "$0")" && exec python3 -m http.server "${1:-8000}" --bind 127.0.0.1
