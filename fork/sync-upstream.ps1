<#
.SYNOPSIS
  Keeps this fork's main branch caught up with the upstream source repo.

.DESCRIPTION
  Fork:     origin   = https://github.com/eric1774/t3code   (you push here)
  Source:   upstream = https://github.com/pingdotgg/t3code  (fetch only; push is disabled)

  Steps:
    1. Refuses to run with uncommitted changes.
    2. Makes sure the origin/upstream remotes exist (upstream push is blocked).
    3. Fetches both remotes and reports where main, origin/main and upstream/main stand.
    4. Already in sync           -> nothing to do (exit 0).
       No custom commits         -> fast-forwards main to upstream/main.
       Custom commits, no clash  -> merges upstream/main into main (merge commit).
       Custom commits, conflicts -> lists the conflicting files and stops (exit 2).
    5. Pushes main to origin (the fork).

  Run it before starting new work on the fork, and before pushing feature work.

.PARAMETER CheckOnly
  Report status and preview conflicts only. Changes nothing. Exit 0 = in sync, 1 = behind/out of sync.

.PARAMETER NoPush
  Update local main but don't push to the fork.

.EXAMPLE
  .\fork\sync-upstream.ps1 -CheckOnly
.EXAMPLE
  .\fork\sync-upstream.ps1
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$ForkUrl     = 'https://github.com/eric1774/t3code.git'
$UpstreamUrl = 'https://github.com/pingdotgg/t3code.git'
$Branch      = 'main'

function Invoke-Git {
  # Runs git, throws on non-zero exit, returns stdout lines.
  $out = & git @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed (exit $LASTEXITCODE)" }
  $out
}
function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# --- 1. Repo + clean tree -------------------------------------------------
Set-Location (Split-Path $PSScriptRoot -Parent)
Invoke-Git rev-parse --is-inside-work-tree | Out-Null

if (Test-Path (Join-Path (Invoke-Git rev-parse --git-dir) 'MERGE_HEAD')) {
  throw "A merge is in progress. Resolve the conflicts, 'git commit', then run this script again."
}
$dirty = Invoke-Git status --porcelain --untracked-files=no   # brand-new untracked files don't block a merge
if ($dirty -and -not $CheckOnly) {
  Say "Uncommitted changes found. Commit or stash them first:" Yellow
  $dirty | ForEach-Object { Say "  $_" Yellow }
  exit 1
}

# --- 2. Remotes -----------------------------------------------------------
$remotes = Invoke-Git remote
if ($remotes -notcontains 'origin')   { Invoke-Git remote add origin $ForkUrl | Out-Null }
if ($remotes -notcontains 'upstream') { Invoke-Git remote add upstream $UpstreamUrl | Out-Null }
Invoke-Git remote set-url --push upstream 'DISABLED-push-to-your-fork-instead' | Out-Null

# --- 3. Fetch + status ----------------------------------------------------
Say "Fetching upstream and origin..." Cyan
& git fetch upstream --quiet
if ($LASTEXITCODE -ne 0) { throw 'git fetch upstream failed' }
& git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { throw 'git fetch origin failed' }

$current = Invoke-Git rev-parse --abbrev-ref HEAD
if ($current -ne $Branch) {
  if ($CheckOnly) { Say "Note: you are on '$current'; checking '$Branch'." Yellow }
  else { Invoke-Git switch $Branch | Out-Null }
}

$local = Invoke-Git rev-parse $Branch
$fork  = Invoke-Git rev-parse "origin/$Branch"
$up    = Invoke-Git rev-parse "upstream/$Branch"
$counts = (Invoke-Git rev-list --left-right --count "$Branch...upstream/$Branch") -split '\s+'
$custom = [int]$counts[0]   # commits on main that upstream doesn't have
$behind = [int]$counts[1]   # upstream commits main doesn't have yet

Say ""
Say ("  local main     {0}" -f $local.Substring(0,10))
Say ("  origin/main    {0}  (your fork on GitHub)" -f $fork.Substring(0,10))
Say ("  upstream/main  {0}  (pingdotgg/t3code)" -f $up.Substring(0,10))
Say ("  behind upstream by {0} commit(s); {1} custom commit(s) of yours" -f $behind, $custom)
Say ""

if ($behind -eq 0) {
  if ($local -eq $fork) { Say "In sync: main = upstream, and the fork matches." Green; exit 0 }
  if ($CheckOnly)       { Say "Up to date with upstream, but local main and the fork differ (push/pull needed)." Yellow; exit 1 }
}
else {
  # --- 4. Preview conflicts before touching anything -------------------
  $conflicts = @()
  if ($custom -gt 0) {
    $mt = & git merge-tree --write-tree --name-only --no-messages $Branch "upstream/$Branch"
    if ($LASTEXITCODE -eq 1) { $conflicts = @($mt | Select-Object -Skip 1 | Where-Object { $_ }) }
    elseif ($LASTEXITCODE -ne 0) { throw 'git merge-tree failed' }
  }

  if ($CheckOnly) {
    Say "Upstream has $behind new commit(s):" Yellow
    Invoke-Git log --oneline --no-decorate -n 15 "$Branch..upstream/$Branch" | ForEach-Object { Say "  $_" }
    if ($behind -gt 15) { Say "  ... and $($behind - 15) more" }
    if ($conflicts.Count) {
      Say "`nThese files will conflict with your custom changes:" Red
      $conflicts | ForEach-Object { Say "  $_" Red }
    }
    exit 1
  }

  if ($custom -eq 0) {
    Say "No custom commits - fast-forwarding main to upstream..." Cyan
    Invoke-Git merge --ff-only --quiet "upstream/$Branch" | Out-Null
  }
  elseif ($conflicts.Count -eq 0) {
    Say "Merging upstream into your custom work (no conflicts detected)..." Cyan
    Invoke-Git merge --no-ff --quiet -m "Merge upstream pingdotgg/t3code main ($($up.Substring(0,10)))" "upstream/$Branch" | Out-Null
  }
  else {
    Say "Upstream changes conflict with your custom work in these files:" Red
    $conflicts | ForEach-Object { Say "  $_" Red }
    Say "`nNothing was changed. To resolve:" Yellow
    Say "  1. git merge upstream/$Branch"
    Say "  2. fix the files above (or ask Claude to), then 'git add' them and 'git commit'"
    Say "  3. run this script again to verify and push"
    exit 2
  }
}

# --- 5. Push to the fork --------------------------------------------------
$local = Invoke-Git rev-parse $Branch
if ($NoPush) { Say "Local main updated to $($local.Substring(0,10)). Skipping push (-NoPush)." Yellow; exit 0 }

Say "Pushing main to your fork (origin)..." Cyan
& git push origin "${Branch}:${Branch}"
if ($LASTEXITCODE -ne 0) { throw 'git push origin failed' }

& git fetch origin --quiet
$fork = Invoke-Git rev-parse "origin/$Branch"
$isUpToDate = (Invoke-Git rev-list --count "$Branch..upstream/$Branch") -eq '0'
if ($fork -eq $local -and $isUpToDate) {
  Say "Done: fork main = $($fork.Substring(0,10)) and includes every upstream commit." Green
} else {
  throw "Verification failed: origin/main=$fork, local main=$local"
}
