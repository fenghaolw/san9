#!/usr/bin/env python3
"""
Local Development Server for San9 x Paradox Grand Strategy
Supports ES2022 Modules, Web Workers, and COOP/COEP headers for SharedArrayBuffer.
Usage: python3 server.py [port]
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

class San9RequestHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
    }

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', PORT), San9RequestHandler) as httpd:
        print(f"============================================================")
        print(f" 《三国志9 × P社大战略》桌面端沙盘服务器已启动")
        print(f" 访问地址: http://localhost:{PORT}")
        print(f" 单元测试: http://localhost:{PORT}/tests/runner.html")
        print(f"============================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
