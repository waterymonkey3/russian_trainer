@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto trypy
python server.py %*
goto done

:trypy
where py >nul 2>nul
if errorlevel 1 goto nopython
py server.py %*
goto done

:nopython
echo [错误] 没有找到 Python 3，请先安装 Python（安装时勾选 Add python.exe to PATH）。

:done
echo.
pause
