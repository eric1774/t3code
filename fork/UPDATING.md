# Updating this fork safely

There are two stages. First you bring upstream's changes into the fork and test them there. Only then do you rebuild and replace the installed app. If stage one fails, your installed app keeps working and nothing is lost.

Run everything from PowerShell in `C:\IT\t3code-fork`.

## 1. See what's coming (changes nothing)

```powershell
.\fork\sync-upstream.ps1 -CheckOnly
```

This fetches both remotes, shows how far behind you are, and previews conflicts. It doesn't merge anything.

If it reports **conflicts** (exit code 2), stop here. Upstream changed something the Brief feature also touches, and it needs a hand merge. The likeliest file is `packages/provider-core/src/server/orchestrationInstructions.ts`, along with `apps/server/src/provider/agentContextBudget.json`.

## 2. Merge locally, without pushing yet

```powershell
.\fork\sync-upstream.ps1 -NoPush
```

This merges upstream into local `main` only. To undo it, run `git reset --hard ORIG_HEAD`.

## 3. Install dependencies, then test the Brief code

```powershell
.\node_modules\.bin\vp i
```

```powershell
.\node_modules\.bin\vp test run apps/server/src/sessionBrief packages/shared/src/sessionBriefText.test.ts apps/server/src/provider
```

These cover the log writes and SB numbering, the Copy format matching the Claude Code mod, and the size budget for agent instructions. Everything should pass. If anything fails, stop.

Always use the repo-local `.\node_modules\.bin\vp`. The globally installed `vp` breaks the test suites.

## 4. Check whether the helper program changed

```powershell
git log --oneline ORIG_HEAD..HEAD -- native/resource-monitor
```

If this prints nothing, the reused `t3-resource-monitor.exe` is still current. If it lists commits, the helper has to be compiled again, which needs Rust and the MSVC build tools. Sort that out before you rebuild.

## 5. Back up T3 data (close T3 first)

```powershell
Copy-Item "$env:USERPROFILE\.t3\userdata" "$env:USERPROFILE\T3-backup-$(Get-Date -Format yyyy-MM-dd)\userdata" -Recurse
```

## 6. Rebuild and install

```powershell
Move-Item .\release\T3-Code-*-x64.exe "$env:USERPROFILE\Downloads\" -Force; $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = '1'; .\node_modules\.bin\vp run dist:desktop:win:x64
```

The first command keeps the previous installer in Downloads, so you can roll back. The build reads the gitignored `.env`, created from `.env.example`, which keeps T3 Connect in the app. If `.env` is missing, run `Copy-Item .env.example .env` first.

When the build finishes, run the new `.exe` in `release\`, open T3, and check that a Brief entry and T3 Connect both work.

## 7. Push to the fork

```powershell
.\fork\sync-upstream.ps1
```

With nothing left to merge, this pushes `main` to `eric1774/t3code`.

## Rollback

1. Reinstall the previous `.exe` from Downloads.
2. If threads or settings look wrong, close T3 and copy the dated backup folder back over `~\.t3\userdata`.
