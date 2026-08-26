# audit.ps1 - Project inspection & verification (Windows PowerShell 5.1 compatible)
# Replaces all ad-hoc inspection one-liners. Uses only PS 5.1 syntax:
# if/else, $null -eq comparisons, full cmdlet names. No ternary/coalescing/null-conditional.

param(
    [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Continue"

Write-Output "==============================================="
Write-Output " PROJECT AUDIT - $ProjectRoot"
Write-Output "==============================================="

# ---- Section 1: PowerShell version ----
Write-Output ""
Write-Output "[1] POWERSHELL VERSION"
$psVer = $PSVersionTable.PSVersion
Write-Output "    Version : $psVer"
Write-Output "    Edition : $($PSVersionTable.PSEdition)"
$is51 = ($psVer.Major -eq 5 -and $psVer.Minor -eq 1)
if ($is51) {
    Write-Output "    Status  : OK (5.1 compatible)"
}
else {
    Write-Output "    Status  : WARNING - not 5.1"
}

# ---- Section 2: External tools / services availability ----
Write-Output ""
Write-Output "[2] ENVIRONMENT TOOLS"

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($null -ne $dockerCmd) {
    Write-Output "    docker      : YES"
}
else {
    Write-Output "    docker      : NO"
}

$psqlCmd = Get-Command psql -ErrorAction SilentlyContinue
if ($null -ne $psqlCmd) {
    Write-Output "    psql        : YES"
}
else {
    Write-Output "    psql        : NO"
}

$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
if ($null -ne $pgService) {
    foreach ($svc in @($pgService)) {
        Write-Output "    pg service  : $($svc.Name) = $($svc.Status)"
    }
}
else {
    Write-Output "    pg service  : none"
}

$portTest = Test-NetConnection -ComputerName localhost -Port 5432 -WarningAction SilentlyContinue
if ($portTest.TcpTestSucceeded) {
    Write-Output "    port 5432   : OPEN"
}
else {
    Write-Output "    port 5432   : CLOSED"
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $nodeCmd) {
    $nodeVersion = & node --version
    Write-Output "    node        : $nodeVersion"
}
else {
    Write-Output "    node        : NOT FOUND"
}

# ---- Section 3: Source file inventory + line count ----
Write-Output ""
Write-Output "[3] SOURCE FILE INVENTORY"

$srcDirs = @("src", "tests")
foreach ($dir in $srcDirs) {
    $dirPath = Join-Path $ProjectRoot $dir
    $dirExists = Test-Path -LiteralPath $dirPath
    if (-not $dirExists) {
        Write-Output "    $dir : MISSING"
        continue
    }
    $files = Get-ChildItem -LiteralPath $dirPath -Recurse -File | Where-Object { $_.Extension -in ".js", ".html", ".css" }
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($ProjectRoot.Length + 1)
        Write-Output ("    {0,-45} {1,8} bytes" -f $rel, $f.Length)
    }
}

$totalLines = 0
foreach ($dir in $srcDirs) {
    $dirPath = Join-Path $ProjectRoot $dir
    $dirExists = Test-Path -LiteralPath $dirPath
    if (-not $dirExists) {
        continue
    }
    $files = Get-ChildItem -LiteralPath $dirPath -Recurse -File | Where-Object { $_.Extension -in ".js", ".html", ".css" }
    foreach ($f in $files) {
        $lineCount = (Get-Content -LiteralPath $f.FullName | Measure-Object -Line).Lines
        $totalLines = $totalLines + $lineCount
    }
}
Write-Output "    TOTAL LOC: $totalLines"

# ---- Section 4: Database schema + data counts (read-only) ----
Write-Output ""
Write-Output "[4] DATABASE SCHEMA + DATA (read-only)"

$dbPath = Join-Path $ProjectRoot "data\pos.db"
$dbExists = Test-Path -LiteralPath $dbPath
if (-not $dbExists) {
    Write-Output "    ERROR: database not found at $dbPath"
}
else {
    $tables = @("products", "categories", "sales", "sale_items", "inventory_movements", "settings", "users", "branches")
    $nodeScript = @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tables = process.argv.slice(3);
for (const t of tables) {
    try {
        const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name).join(', ');
        console.log(t.toUpperCase() + ': ' + cols);
    } catch (e) {
        console.log(t.toUpperCase() + ': <table missing>');
    }
}
for (const t of ['products', 'categories', 'sales']) {
    try {
        const n = db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
        console.log('COUNT ' + t + ' = ' + n);
    } catch (e) {
        console.log('COUNT ' + t + ' = <n/a>');
    }
}
db.close();
"@
    $tmpScript = Join-Path $env:TEMP "audit_schema_check.js"
    Set-Content -LiteralPath $tmpScript -Value $nodeScript -Encoding UTF8
    & node $tmpScript $dbPath @tables
    Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
}

# ---- Section 5: PowerShell scripts syntax scan (PS7-only operators) ----
Write-Output ""
Write-Output "[5] PS SYNTAX SCAN (scripts/*.ps1)"

$scanDir = Join-Path $ProjectRoot "scripts"
$scanExists = Test-Path -LiteralPath $scanDir
if (-not $scanExists) {
    Write-Output "    no scripts directory"
}
else {
    $psFiles = Get-ChildItem -LiteralPath $scanDir -Filter "*.ps1" -File
    if (@($psFiles).Count -eq 0) {
        Write-Output "    no .ps1 files"
    }
    else {
        foreach ($pf in $psFiles) {
            $tokens = $null
            $parseErrors = $null
            $null = [System.Management.Automation.Language.Parser]::ParseFile($pf.FullName, [ref]$tokens, [ref]$parseErrors)
            if (@($parseErrors).Count -eq 0) {
                Write-Output "    $($pf.Name): PARSE OK (0 errors)"
            }
            else {
                foreach ($pe in $parseErrors) {
                    Write-Output "    $($pf.Name): ERROR line $($pe.Extent.StartLineNumber): $($pe.Message)"
                }
            }
        }
    }
}

Write-Output ""
Write-Output "==============================================="
Write-Output " AUDIT COMPLETE"
Write-Output "==============================================="
