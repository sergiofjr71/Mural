#!/usr/bin/env python3
"""Servidor local — serve a RAIZ do projeto com cache bust automático."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import subprocess
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', '3001'))
BUILD_STAMP = os.environ.get('MURAL_BUILD', 'dev-root')
ASSET_RE = re.compile(
    r'((?:href|src)=["\'])([^"\']+\.(?:css|js))(?:\?[^"\']*)?(["\'])',
    re.IGNORECASE,
)


def file_stat(rel_path: str) -> dict:
    path = os.path.join(ROOT, rel_path)
    if not os.path.isfile(path):
        return {'exists': False, 'mtime': 0, 'size': 0}
    stat = os.stat(path)
    return {
        'exists': True,
        'mtime': int(stat.st_mtime),
        'size': stat.st_size,
    }


def git_head() -> str:
    try:
        return subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=ROOT,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return 'unknown'


def dev_status_payload() -> dict:
    tracked = [
        'index.html',
        'css/style.css',
        'js/app.js',
        'js/platform.js',
    ]
    return {
        'ok': True,
        'source': 'project-root',
        'build': BUILD_STAMP,
        'git': git_head(),
        'root': ROOT,
        'url': f'http://localhost:{PORT}/',
        'files': {name: file_stat(name) for name in tracked},
        'warnings': [],
    }


def inject_cache_bust(html: str) -> str:
    def replace(match: re.Match) -> str:
        prefix, url, suffix = match.groups()
        clean = url.split('?')[0]
        mtime = file_stat(clean)['mtime']
        token = mtime or '0'
        return f'{prefix}{clean}?m={token}{suffix}'

    return ASSET_RE.sub(replace, html)


class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('X-Mural-Source', 'project-root')
        self.send_header('X-Mural-Build', BUILD_STAMP)
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == '/__mural__/dev-status.json':
            payload = dev_status_payload()
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path in ('/', '/index.html'):
            index_path = os.path.join(ROOT, 'index.html')
            try:
                with open(index_path, 'r', encoding='utf-8') as handle:
                    html = inject_cache_bust(handle.read())
                body = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Mural-Index-Mtime', str(file_stat('index.html')['mtime']))
                self.end_headers()
                self.wfile.write(body)
                return
            except OSError as err:
                self.send_error(500, f'index.html: {err}')
                return

        return super().do_GET()

    def log_message(self, format, *args):
        print(f"[mural-dev] {format % args}")


if __name__ == '__main__':
    os.chdir(ROOT)
    if os.path.basename(os.getcwd()) == 'www':
        raise SystemExit('ERRO: não execute o servidor dentro de www/. Use: npm run dev')
    server = ThreadingHTTPServer(('0.0.0.0', PORT), DevHandler)
    print(f'Mural DEV → http://localhost:{PORT}')
    print(f'Fonte: {ROOT}')
    print(f'Git: {git_head()}')
    print(f'Diagnóstico: http://localhost:{PORT}/__mural__/dev-status.json')
    print('A pasta www/ é só para Capacitor. O navegador usa a raiz.')
    server.serve_forever()
