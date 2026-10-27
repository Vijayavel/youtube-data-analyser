"""Local dev server for the app that tells the browser not to cache, so edits show up on reload."""
import http.server
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class DualStackServer(http.server.ThreadingHTTPServer):
    """Listens on IPv6 and IPv4, so http://localhost works whichever one the browser picks."""
    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


if __name__ == "__main__":
    with DualStackServer(("::", PORT), NoCacheHandler) as httpd:
        print(f"Serving on http://localhost:{PORT}", flush=True)
        httpd.serve_forever()
