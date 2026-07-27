@echo off
rem ASCII only. Do NOT add non-ASCII text or chcp here:
rem cmd.exe reads .bat with the system codepage and both break parsing.
cd /d "%~dp0"
title Tenka Template - local server

echo.
echo   Tenka Template Editor - local preview server
echo   ============================================
echo.
echo   URL  :  http://localhost:8000
echo   Stop :  Ctrl+C , or just close this window
echo.

rem "py" (Python launcher) first: "python" can be the Microsoft Store stub.
where py      >nul 2>nul && goto RUN_PY_LAUNCHER
where python  >nul 2>nul && goto RUN_PYTHON
where npx     >nul 2>nul && goto RUN_NPX
goto NOT_FOUND

:RUN_PY_LAUNCHER
start "" http://localhost:8000
py -m http.server 8000
goto END

:RUN_PYTHON
start "" http://localhost:8000
python -m http.server 8000
goto END

:RUN_NPX
start "" http://localhost:8000
rem -c-1 disables caching, so edits show up on a plain refresh.
npx --yes http-server -p 8000 -c-1
goto END

:NOT_FOUND
echo   [!] Neither Python nor Node.js was found.
echo.
echo   Install either one, then run this file again:
echo     Python   https://www.python.org/downloads/
echo     Node.js  https://nodejs.org/
echo.

:END
echo.
pause
