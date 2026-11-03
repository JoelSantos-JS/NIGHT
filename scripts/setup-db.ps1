# Cria o usuário e os bancos do Night no PostgreSQL 18 local.
# Rode no PowerShell: .\scripts\setup-db.ps1
# O psql pede a senha do 'postgres' a você; ela não fica salva em lugar nenhum.
# A senha do usuário 'night' é aleatória e vai só para %APPDATA%\postgresql\pgpass.conf.
# Pode rodar de novo: troca a senha do 'night' e não apaga dados.

$ErrorActionPreference = 'Stop'
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$port = 5433

$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pw = ([Convert]::ToBase64String($bytes)) -replace '[+/=]', ''

$sql = @'
SELECT format('CREATE ROLE night LOGIN PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'night') \gexec
SELECT format('ALTER ROLE night PASSWORD %L', :'pw') \gexec
SELECT 'CREATE DATABASE night OWNER night'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'night') \gexec
SELECT 'CREATE DATABASE night_test OWNER night'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'night_test') \gexec
'@
$tmp = New-TemporaryFile
Set-Content -Path $tmp -Value $sql -Encoding ascii
try {
  & $psql -h localhost -p $port -U postgres -d postgres -v ON_ERROR_STOP=1 -v "pw=$pw" -f $tmp
  if ($LASTEXITCODE -ne 0) { throw "psql falhou (código $LASTEXITCODE)" }
} finally {
  Remove-Item $tmp
}

$dir = Join-Path $env:APPDATA 'postgresql'
$pgpass = Join-Path $dir 'pgpass.conf'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$lines = @()
if (Test-Path $pgpass) { $lines = @(Get-Content $pgpass | Where-Object { $_ -notmatch "^localhost:${port}:\*:night:" }) }
$lines += "localhost:${port}:*:night:$pw"
Set-Content -Path $pgpass -Value $lines -Encoding ascii

Write-Host "Pronto: usuario 'night', bancos 'night' e 'night_test' na porta $port. Senha em $pgpass."
