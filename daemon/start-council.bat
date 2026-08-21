@echo off
REM AI Council daemon — real SQLite Project Brain + MCP server for Antigravity
REM Endpoint: http://127.0.0.1:8765   (MCP: /mcp)   Brain: %USERPROFILE%\.ai-council\council.db
cd /d "%~dp0"
echo Starting AI Council daemon on http://127.0.0.1:8765 ...
node server.js
pause
