# A browser server for evidence-mcp's multi-stage download: Playwright's `run-server`
# on Microsoft's Playwright image (Chromium and Xvfb included), headed under
# Xvfb — headed Chromium clears Cloudflare's "Just a moment…" where headless
# does not. The MCP server connects with ws://host:8932 (config.json
# FH_PLAYWRIGHT_n). Run one next to the server and one on a residential line.
#
# The tag MUST match playwright-core in the server's package.json: driver and
# browser are versioned together.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
RUN npm install -g playwright-core@1.65.0 && npm cache clean --force
EXPOSE 8932
# No authentication of its own: publish on localhost or a tailnet IP only
# (compose.yaml), never on 0.0.0.0 of a LAN or the internet.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "playwright-core", "run-server", "--port", "8932", "--host", "0.0.0.0"]
