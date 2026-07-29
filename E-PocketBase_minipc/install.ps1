# =====================================================================
# 진동시험기 예약 (E-PocketBase) — 미니PC(윈도우) 설치 스크립트
#
# 실행: 관리자 PowerShell에서
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# 하는 일:
#   1. PocketBase 0.39.9 (windows_amd64) 다운로드  — 이미 있으면 생략
#   2. 앱 파일(pb_public, pb_migrations)을 ../E-PocketBase 에서 복사
#   3. 방화벽 인바운드 8090 허용
#   4. 부팅 시 자동시작 (작업 스케줄러, SYSTEM 계정)
#   5. 기동 및 헬스체크
#
# 재실행해도 안전합니다(멱등). 소스 갱신 시에도 이 스크립트를 다시 실행하면 됩니다.
# 예약 데이터(pb_data)는 절대 건드리지 않습니다.
# =====================================================================

$ErrorActionPreference = "Stop"

$Root      = "C:\vibres"
$PbVersion = "0.39.9"           # 라즈베리파이 버전과 동일하게 고정
$Port      = 8090
$RepoApp   = Join-Path $PSScriptRoot "..\E-PocketBase"   # 앱 본체는 한 벌만 유지
$TaskName  = "vibres"

# --- 0. 사전 확인 ------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[중단] 관리자 PowerShell에서 실행하세요. (방화벽·자동시작 등록에 필요)" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $RepoApp "pb_public\index.html"))) {
    Write-Host "[중단] ../E-PocketBase 에서 앱 파일을 찾을 수 없습니다. 저장소 안에서 실행하세요." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force $Root | Out-Null

# --- 1. PocketBase 실행파일 -------------------------------------------
$exe = Join-Path $Root "pocketbase.exe"
$needDownload = $true
if (Test-Path $exe) {
    $cur = (& $exe --version) -replace '[^\d.]',''
    if ($cur -eq $PbVersion) { $needDownload = $false; Write-Host "[1/5] PocketBase $PbVersion 이미 설치됨" }
}
if ($needDownload) {
    Write-Host "[1/5] PocketBase $PbVersion 다운로드..."
    $zip = Join-Path $env:TEMP "pb.zip"
    Invoke-WebRequest -Uri "https://github.com/pocketbase/pocketbase/releases/download/v$PbVersion/pocketbase_${PbVersion}_windows_amd64.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $Root -Force
    Remove-Item $zip
}

# --- 2. 앱 파일 복사 (저장소 → 실행 위치) ------------------------------
Write-Host "[2/5] 앱 파일 복사 (pb_public, pb_migrations, pb_hooks)"
Copy-Item -Recurse -Force (Join-Path $RepoApp "pb_public")     (Join-Path $Root "pb_public")
Copy-Item -Recurse -Force (Join-Path $RepoApp "pb_migrations") (Join-Path $Root "pb_migrations")
# 메일 알림 훅. SMTP 미설정이면 아무 일도 하지 않으므로 항상 함께 둔다.
Copy-Item -Recurse -Force (Join-Path $RepoApp "pb_hooks")      (Join-Path $Root "pb_hooks")

# --- 3. 방화벽 --------------------------------------------------------
if (-not (Get-NetFirewallRule -DisplayName "vibres $Port" -ErrorAction SilentlyContinue)) {
    Write-Host "[3/5] 방화벽 인바운드 $Port 허용 규칙 추가"
    New-NetFirewallRule -DisplayName "vibres $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
} else {
    Write-Host "[3/5] 방화벽 규칙 이미 있음"
}

# --- 4. 자동시작 등록 (작업 스케줄러) ----------------------------------
Write-Host "[4/5] 부팅 시 자동시작 등록 (작업 스케줄러: $TaskName)"
$action    = New-ScheduledTaskAction -Execute $exe -Argument "serve --http=0.0.0.0:$Port --dir=$Root\pb_data --publicDir=$Root\pb_public --migrationsDir=$Root\pb_migrations --hooksDir=$Root\pb_hooks" -WorkingDirectory $Root
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# --- 5. (재)기동 및 헬스체크 -------------------------------------------
Write-Host "[5/5] 서버 기동"
Get-Process pocketbase -ErrorAction SilentlyContinue | Stop-Process -Force      # 수동 실행분 정리
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

try {
    $h = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing
    Write-Host ""
    Write-Host "설치 완료. 헬스체크: $($h.Content)" -ForegroundColor Green
} catch {
    Write-Host "[실패] 서버가 응답하지 않습니다. 확인: Get-ScheduledTaskInfo -TaskName $TaskName" -ForegroundColor Red
    exit 1
}

$ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway }).IPv4Address.IPAddress
Write-Host ""
Write-Host "  예약 화면:   http://${ip}:$Port/"
Write-Host "  관리자 화면: http://${ip}:$Port/_/   (최초 접속 시 관리자 계정 생성)"
Write-Host ""
Write-Host "  10층·12층 다른 PC 브라우저에서 위 주소가 열리는지 확인하세요."
