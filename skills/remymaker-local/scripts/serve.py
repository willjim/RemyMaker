#!/usr/bin/env python3
"""Serve the bundled RemyMaker snapshot with its local resolver endpoint."""

import argparse
import atexit
import json
import os
import re
import shutil
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ALLOWED_HOSTS = {
    "www.remy3d.cn",
    "remy3d.cn",
    "www.kiriengine.app",
    "kiriengine.app",
    "www.kiriengine.com",
    "kiriengine.com",
}


def parse_share_page(html, is_kiri):
    match = re.search(r'id="__NUXT_DATA__"[^>]*>([\s\S]*?)</script>', html)
    if not match:
        raise ValueError("Page does not contain Nuxt model data")
    data = json.loads(match.group(1))
    result = {"splatUrl": None, "plyUrl": None, "pcdUrl": None, "camerasUrl": None}
    unsupported_mesh = None
    for value in data:
        if not isinstance(value, str):
            continue
        value = value.replace(r"\u002F", "/")
        if not value.startswith("https://"):
            continue
        if ".splat" in value:
            result["splatUrl"] = value
        if "cameras.json" in value:
            result["camerasUrl"] = value
        if ".glb" in value:
            unsupported_mesh = value
        if ".ply" in value:
            if "pcd.ply" in value or "/input/" in value:
                result["pcdUrl"] = value
            elif not result["plyUrl"] or "3DGS.ply" in value or "/output/" in value:
                result["plyUrl"] = value
    if not result["splatUrl"] and not result["plyUrl"]:
        if is_kiri and unsupported_mesh:
            raise ValueError("This Kiri share is a Mesh model, not 3DGS")
        raise ValueError("No supported Splat or PLY asset found")
    result["name"] = find_name(data, "Kiri Model" if is_kiri else "Remy Model")
    return result


def find_name(data, fallback):
    for index, value in enumerate(data):
        if value != "name":
            continue
        for candidate in data[index + 1:index + 5]:
            if isinstance(candidate, str) and len(candidate) < 100 and "http" not in candidate:
                return candidate
    return fallback


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
        self.end_headers()

    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path == "/resolve":
            self.resolve_share()
            return
        super().do_GET()

    def resolve_share(self):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target = query.get("url", [""])[0]
        try:
            parsed = urllib.parse.urlsplit(target)
            if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
                self.send_text("Share host is not allowed", 403)
                return
            is_kiri = "kiri" in parsed.hostname
            if not (parsed.path.startswith("/share/") or (not is_kiri and parsed.path.startswith("/model/"))):
                self.send_text("Unsupported share URL path", 403)
                return
            request = urllib.request.Request(
                target,
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "Referer": "https://www.kiriengine.app/" if is_kiri else "https://www.remy3d.cn/",
                    "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36",
                },
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                html = response.read().decode("utf-8", errors="replace")
            body = json.dumps(parse_share_page(html, is_kiri), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ValueError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            self.send_text("Unable to resolve share page: {}".format(error), 502)

    def send_text(self, message, status):
        body = message.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Run RemyMaker locally")
    parser.add_argument("--port", type=int, default=0, help="loopback port; 0 chooses a free port")
    args = parser.parse_args()

    skill_dir = Path(__file__).resolve().parent.parent
    archive = skill_dir / "assets" / "remymaker-site.tar.gz"
    site_dir = Path(tempfile.mkdtemp(prefix="remymaker-site-"))
    atexit.register(shutil.rmtree, str(site_dir), True)
    with tarfile.open(str(archive), "r:gz") as bundle:
        bundle.extractall(str(site_dir))
    os.chdir(str(site_dir))

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("RemyMaker: http://127.0.0.1:{}/".format(server.server_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
