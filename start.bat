@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
if not exist "data\questions.json" (
  echo Разбираю Excel...
  python parse_xlsx.py
)
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:8765"
echo Тренажёр запущен: http://localhost:8765
echo Закройте это окно, чтобы остановить сервер.
python server.py
pause
