@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo.
echo ================================
echo  WhatsApp Batch Video Converter
echo ================================
echo.

set /p "SRC=Folder to convert [blank = current folder]: "

if "%SRC%"=="" (
    set "SRC=%CD%"
)

if not exist "%SRC%" (
    echo.
    echo ERROR: Folder does not exist:
    echo "%SRC%"
    pause
    exit /b 1
)

echo.
echo Source folder:
echo "%SRC%"
echo.

echo Choose preset:
echo.
echo   1. 360p  - small, good for long clips
echo   2. 480p  - balanced small
echo   3. 720p  - better quality, gameplay-friendly
echo.

set /p "PRESET=Enter choice [1/2/3]: "

if "%PRESET%"=="1" (
    set "HEIGHT=360"
    set "MAX=1200k"
    set "BUF=2400k"
    set "LEVEL=3.1"
    set "CRF=24"
    set "NAME=360p"
) else if "%PRESET%"=="2" (
    set "HEIGHT=480"
    set "MAX=2200k"
    set "BUF=4400k"
    set "LEVEL=3.1"
    set "CRF=22"
    set "NAME=480p"
) else if "%PRESET%"=="3" (
    set "HEIGHT=720"
    set "MAX=4200k"
    set "BUF=8400k"
    set "LEVEL=4.1"
    set "CRF=20"
    set "NAME=720p"
) else (
    echo.
    echo ERROR: Invalid preset.
    pause
    exit /b 1
)

echo.
echo Selected preset: %NAME%
echo Resolution height: %HEIGHT%
echo CRF quality:       %CRF%
echo Maxrate:           %MAX%
echo Buffer:            %BUF%
echo.

set "OUT=%SRC%\whatsapp_%NAME%"

if not exist "%OUT%" (
    mkdir "%OUT%"
)

echo Output folder:
echo "%OUT%"
echo.

echo Starting conversion...
echo.

pushd "%SRC%" || exit /b 1

set "FOUND=0"

for %%F in (*.mp4 *.mov *.mkv *.avi *.webm) do (
    set "FOUND=1"

    echo.
    echo ========================================
    echo Converting: %%F
    echo ========================================

    ffmpeg -y -i "%%F" ^
        -map 0:v:0 -map 0:a? ^
        -vf "scale=-2:%HEIGHT%:flags=lanczos" ^
        -c:v libx264 ^
        -preset slow ^
        -profile:v high ^
        -level %LEVEL% ^
        -pix_fmt yuv420p ^
        -crf %CRF% ^
        -maxrate %MAX% ^
        -bufsize %BUF% ^
        -g 120 ^
        -keyint_min 60 ^
        -sc_threshold 40 ^
        -bf 3 ^
        -refs 4 ^
        -rc-lookahead 40 ^
        -x264-params "aq-mode=3:aq-strength=0.8" ^
        -c:a aac ^
        -q:a 2 ^
        -ar 48000 ^
        -ac 2 ^
        -movflags +faststart ^
        "%OUT%\%%~nF_whatsapp_%NAME%.mp4"

    if errorlevel 1 (
        echo.
        echo FAILED: %%F
        echo.
    ) else (
        echo.
        echo SUCCESS: %%F
        echo.
    )
)

popd

if "%FOUND%"=="0" (
    echo.
    echo No video files found in:
    echo "%SRC%"
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo Done.
echo Converted files are in:
echo "%OUT%"
echo ========================================
echo.

pause