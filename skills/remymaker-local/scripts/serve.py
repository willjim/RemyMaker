#!/usr/bin/env python3
"""Serve the bundled RemyMaker site with its local resolver endpoint."""

import argparse
import json
import os
import re
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
    "app.insta360.com",
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


def parse_insta360_share_page(html):
    match = re.search(r'id=["\']__NEXT_DATA__["\'][^>]*>([\s\S]*?)</script>', html)
    if not match:
        raise ValueError("Page does not contain Insta360 model data")

    next_data = json.loads(match.group(1))
    if not isinstance(next_data, dict):
        next_data = {}
    props = next_data.get("props")
    if not isinstance(props, dict):
        props = {}
    page_props = props.get("pageProps")
    if not isinstance(page_props, dict):
        page_props = {}
    task_detail = page_props.get("taskDetail")
    if not isinstance(task_detail, dict):
        task_detail = {}
    outputs = task_detail.get("outputs")
    if not isinstance(outputs, list):
        raise ValueError("Insta360 task does not contain model outputs")

    result = {
        "sogUrl": None,
        "splatUrl": None,
        "plyUrl": None,
        "pcdUrl": None,
        "camerasUrl": None,
    }
    for output in outputs:
        if not isinstance(output, dict):
            continue
        url = output.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            continue
        file_format = str(output.get("fileFormat", "")).lower()
        output_type = str(output.get("type", "")).lower()
        if output_type == "model" and file_format == "sog":
            result["sogUrl"] = url
        if output_type == "model" and file_format == "splat":
            result["splatUrl"] = url
        if output_type == "model" and file_format == "ply":
            result["plyUrl"] = url
        if file_format == "json" and re.search(r'cameras\.json(?:\?|$)', url, re.IGNORECASE):
            result["camerasUrl"] = url

    if not result["sogUrl"] and not result["splatUrl"] and not result["plyUrl"]:
        raise ValueError("No supported SOG, Splat, or PLY asset found")

    title = task_detail.get("title")
    result["name"] = title.strip() if isinstance(title, str) and title.strip() else "Insta360 Model"
    result["source"] = "insta360"
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
            is_insta360 = parsed.hostname == "app.insta360.com"
            if is_insta360:
                valid_path = parsed.path.startswith("/3dspace/detail/")
            elif is_kiri:
                valid_path = parsed.path.startswith("/share/")
            else:
                valid_path = parsed.path.startswith("/model/") or parsed.path.startswith("/share/")
            if not valid_path:
                self.send_text("Unsupported share URL path", 403)
                return
            if is_insta360:
                referer = "https://app.insta360.com/"
            elif is_kiri:
                referer = "https://www.kiriengine.app/"
            else:
                referer = "https://www.remy3d.cn/"
            request = urllib.request.Request(
                target,
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "Cache-Control": "no-cache, no-store, max-age=0",
                    "Pragma": "no-cache",
                    "Referer": referer,
                    "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36",
                },
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                html = response.read().decode("utf-8", errors="replace")
            result = parse_insta360_share_page(html) if is_insta360 else parse_share_page(html, is_kiri)
            body = json.dumps(result, ensure_ascii=False).encode("utf-8")
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
    site_dir = skill_dir / "assets" / "remymaker-site"
    if not (site_dir / "index.html").is_file():
        raise SystemExit("Bundled RemyMaker site is missing index.html")
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
