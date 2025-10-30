@echo off
rem Thay doi code page sang UTF-8 (de hien thi tieng Viet)
chcp 65001 > nul
title Deploy Bot len Koyeb

echo ---[ BAT DAU CAP NHAT BOT LEN KOYEB ]---
echo.

rem --- Buoc 1: Them file ---
echo [1/3] Dang them tat ca cac file da thay doi (git add .)...
git add .
echo.

rem --- Buoc 2: Dong goi (Commit) ---
echo [2/3] Vui long nhap Ghi chu (commit message) cho ban cap nhat nay:
set /p commitMessage="Ghi chu (Vi du: Sua loi an cung): "

rem Kiem tra xem co bo trong khong, neu trong thi dat ten mac dinh
if "%commitMessage%"=="" set commitMessage="Cap nhat code nhanh"

echo Dang dong goi voi ghi chu: "%commitMessage%"
git commit -m "%commitMessage%"
echo.

rem --- Buoc 3: Day code (Push) ---
echo [3/3] Dang day code len GitHub/Koyeb (git push origin main)...
git push origin main
echo.

rem --- Hoan tat ---
echo ------------------------------------------
echo.
echo ---[ HOAN TAT! ]---
echo.
echo Koyeb se tu dong deploy ban moi trong vai phut.
echo (Ban co the dong cua so nay)
echo ------------------------------------------
echo.

rem Giu cua so mo de doc ket qua
pause