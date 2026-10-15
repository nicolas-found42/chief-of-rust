#!/usr/bin/env python3
"""Exercise the shipped SSR routes and a Task across a process restart."""
import sys
import urllib.request
import urllib.parse
import urllib.error

base = sys.argv[1].rstrip("/")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(NoRedirect)
def read(path):
    with urllib.request.urlopen(base + path, timeout=20) as response:
        assert response.status == 200, path
        return response.read().decode()
assert "chief-of-rust" in read("/healthz")
for path, text in [("/", "Chief of Staff"), ("/meetings", "Upcoming"), ("/content-scout", "Content Engine"), ("/content-research", "Research"), ("/terminal", "Bloomberg Terminal"), ("/tasks", "Tasks"), ("/settings", "Model diagnostic"), ("/runs", "Runs")]:
    assert text in read(path), path
if "--verify-persistence" in sys.argv:
    assert "Container persistence check" in read("/tasks"), "Task disappeared on restart"
    print("PASS: five products, settings, Runs, health, persisted Task after restart")
else:
    request = urllib.request.Request(base+"/tasks", data=urllib.parse.urlencode({"title":"Container persistence check"}).encode())
    try:
        opener.open(request, timeout=20)
        raise AssertionError("Expected a redirect after Task creation")
    except urllib.error.HTTPError as response:
        assert response.code == 303, response.code
        path = response.headers["Location"]
    assert "Container persistence check" in read(path)
    print("PASS: five products, settings, Runs, health, Task create and detail")
