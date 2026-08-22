@echo off
REM Build the portable council-daemon.exe (Node SEA).
REM Output: council-daemon.exe in this folder (~100 MB, no install needed).
REM Requires: Node >= 22.5 on PATH; one-time npx postject download.
cd /d "%~dp0"

echo [1/4] Bundling daemon modules...
node build-bundle.js || goto :err

echo [2/4] Generating SEA blob...
node --experimental-sea-config sea-config.json || goto :err

echo [3/4] Copying node runtime...
where node >nul 2>nul || goto :err
for /f "delims=" %%i in ('where node') do set NODE_EXE=%%i
copy /y "%NODE_EXE%" council-daemon.exe >nul || goto :err

echo [4/4] Injecting blob (postject)...
REM Node 25 rotated the SEA fuse id (ends df1996b2, not 1991999b2)
call npx --yes postject council-daemon.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite || goto :err

echo.
echo DONE: council-daemon.exe — double-click to run (listens on 127.0.0.1:8765).
exit /b 0
:err
echo BUILD FAILED (see messages above).
exit /b 1
