# =====================================================================
# 진동시험기 예약 (E-PocketBase) — 미니PC(윈도우) 설치 스크립트
#
# 실행: 관리자 PowerShell에서
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# 하는 일:
#   1. PocketBase 0.39.9 (windows_amd64) 다운로드  — 이미 있으면 생략
#   2. 앱 파일(pb_public, pb_migrations)을 ../E-PocketBase 에서 복사
#   3. 방화벽 인바운드 8090 허용 + ping(ICMP) 응답 허용
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
    # --version 출력은 "pocketbase.exe version 0.39.9" 이고, pb_hooks 가 있으면
    # 훅 로그 줄까지 섞여 나온다. 단순 문자 제거로는 비교가 깨져(항상 재다운로드)
    # 버전 숫자만 정규식으로 뽑는다.
    $cur = [regex]::Match(((& $exe --version) -join ' '), '\d+\.\d+\.\d+').Value
    if ($cur -eq $PbVersion) { $needDownload = $false; Write-Host "[1/5] PocketBase $PbVersion 이미 설치됨" }
}
if ($needDownload) {
    Write-Host "[1/5] PocketBase $PbVersion 다운로드..."
    # 실행 중인 exe 는 잠겨 있어 덮어쓸 수 없다. 받기 전에 내린다(아래 5단계에서 재기동).
    Get-Process pocketbase -ErrorAction SilentlyContinue | Stop-Process -Force
    $zip = Join-Path $env:TEMP "pb.zip"
    Invoke-WebRequest -Uri "https://github.com/pocketbase/pocketbase/releases/download/v$PbVersion/pocketbase_${PbVersion}_windows_amd64.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $Root -Force
    Remove-Item $zip
}

# --- 2. 앱 파일 복사 (저장소 → 실행 위치) ------------------------------
# Copy-Item 은 대상 폴더가 이미 있으면 "안으로" 복사해 pb_public\pb_public 처럼
# 중첩되고, 최상위에는 낡은 파일이 남는다. 재실행을 안전하게 하려면 지우고 새로 뜬다.
# (pb_data 는 여기 목록에 없다 — 예약 데이터는 절대 건드리지 않는다)
Write-Host "[2/5] 앱 파일 복사 (pb_public, pb_migrations, pb_hooks)"
foreach ($d in "pb_public", "pb_migrations", "pb_hooks") {
    $dst = Join-Path $Root $d
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse (Join-Path $RepoApp $d) $dst
}

# 화면 좌측 하단에 배포 커밋을 찍는다 (update.sh 와 같은 방식).
# 없으면 "개발용(미배포)" 로 떠서 최신 화면인지 눈으로 판별할 수 없다.
$index = Join-Path $Root "pb_public\index.html"
$hash  = git -C $PSScriptRoot rev-parse --short HEAD 2>$null
if ($hash) {
    $stamp = "$hash ($(Get-Date -Format 'MM-dd HH:mm'))"
    (Get-Content $index -Raw -Encoding utf8) -replace '__BUILD__', $stamp |
        Set-Content $index -Encoding utf8 -NoNewline
    Write-Host "      화면 버전 표시: $stamp"
}

# --- 3. 방화벽 --------------------------------------------------------
if (-not (Get-NetFirewallRule -DisplayName "vibres $Port" -ErrorAction SilentlyContinue)) {
    Write-Host "[3/5] 방화벽 인바운드 $Port 허용 규칙 추가"
    New-NetFirewallRule -DisplayName "vibres $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
} else {
    Write-Host "[3/5] 방화벽 규칙 이미 있음"
}

# ping 응답 허용. 윈도우는 ICMP 를 기본 차단하므로, 열지 않으면 다른 층에서 보낸 ping 이
# 실패한다 — 서버가 멀쩡하고 라우팅도 되는데도 그렇다. 실제로 2026-07-30 같은 12층
# 서브넷의 데탑에서 ping 이 실패했다(3389 은 열려 있었다). 그 실패를 "층간 라우팅 없음"
# 으로 읽으면 쓸 수 있는 사내 호스팅을 버리고 외부 호스팅으로 가는 오판을 하게 된다.
# 진단을 믿을 수 있게 만들려고 함께 연다. 서비스 동작에는 영향이 없다.
if (-not (Get-NetFirewallRule -DisplayName "vibres ICMPv4" -ErrorAction SilentlyContinue)) {
    Write-Host "      ping(ICMPv4 echo) 허용 규칙 추가 — 층간 진단용"
    New-NetFirewallRule -DisplayName "vibres ICMPv4" -Direction Inbound -Protocol ICMPv4 -IcmpType 8 -Action Allow | Out-Null
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
