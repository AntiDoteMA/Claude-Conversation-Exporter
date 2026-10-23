@echo off
setlocal
cd /d "%~dp0"

if not exist "conversation.json" (
  echo conversation.json was not found in %~dp0
  echo Download it with the Claude Conversation Exporter first.
  exit /b 1
)

python transcript_extract.py --format json --out transcript.json
if errorlevel 1 exit /b %errorlevel%

python transcript_extract.py --out transcript.md
if errorlevel 1 exit /b %errorlevel%

endlocal