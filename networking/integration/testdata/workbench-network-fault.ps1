param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [Parameter(Mandatory = $true)][ValidateSet('setup', 'cut', 'close', 'watchdog', 'probe')][string]$Operation,
    [ValidateSet('none', 'inbound', 'outbound', 'both')][string]$Direction = 'none',
    [long]$Milliseconds = 0
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$plan = [IO.File]::ReadAllText($PlanPath) | ConvertFrom-Json
if ($plan.version -ne 1 -or $plan.id -notmatch '^[a-f0-9]{32}$') { throw 'test.firewall_invalid_plan' }
$root = [IO.Path]::GetFullPath($plan.root)
if ([IO.Path]::GetDirectoryName($PlanPath) -ne $root -or [IO.Path]::GetDirectoryName($plan.script) -ne $root) { throw 'test.firewall_invalid_plan_root' }
$taskName = 'DSHKer-UDPFault-' + $plan.id
$names = @(($taskName + '-in'), ($taskName + '-out'), ($taskName + '-proof'))
$deadline = [DateTimeOffset]::Parse($plan.deadlineUtc).UtcDateTime
$expired = Join-Path $root 'expired.json'
$proofFile = Join-Path $root 'watchdog-proof.json'
$receiptFile = Join-Path $root 'watchdog-receipt.json'
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$mutex = New-Object Threading.Mutex($false, ('Global\DSHKerUDPFault-' + $plan.id))
$proof = [ordered]@{
    id = $plan.id; operation = $Operation; direction = $Direction; corePID = $plan.corePID
    identityVerified = $false; activeRules = 0; ruleNames = $names
    requestedMilliseconds = $Milliseconds; heldMilliseconds = 0
    releaseStartedAt = '0001-01-01T00:00:00Z'; releasedAt = '0001-01-01T00:00:00Z'
    errorCode = ''; cleanupError = ''; watchdogDeadline = $deadline.ToString('o'); cleanupConfirmed = $false
}

function Save-Record([string]$file, $value) {
    $temporary = $file + '.' + [Guid]::NewGuid().ToString('N') + '.pending'
    $json = $value | ConvertTo-Json -Depth 6 -Compress
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    # Windows PowerShell 5.1 binds $null to an empty string for this overload.
    # NullString is the explicit .NET null backup path, not an alternate writer.
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $file) }
}
function With-Lock([scriptblock]$body) {
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(5000) }
        catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'test.firewall_mutex_timeout' }
        $script:plan = [IO.File]::ReadAllText($PlanPath) | ConvertFrom-Json
        & $body
    }
    finally { if ($owned) { $mutex.ReleaseMutex() } }
}
function Save-Ownership { Save-Record $PlanPath $plan }
function Rule-Owned([string]$name) {
    if ($name -notin @($plan.ownedRules) -and $name -notin @($plan.pendingRules)) { return $false }
    $rule = Read-Rule $name
    if ($null -eq $rule) { return $false }
    if ($rule.Description -ne ('Isolated DSHKer UDP fault ' + $plan.id + ' root=' + $root) -or
        $rule.ApplicationName -ne $plan.executable -or $rule.Protocol -ne 17) { throw 'test.firewall_rule_ownership_lost' }
    return $true
}
function Read-Rule([string]$name) {
    try { return $policy.Rules.Item($name) }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
        if (($exception.HResult -band 0xffffffffL) -ne 0x80070002L) { throw }
        return $null
    }
}
function Remove-Rules {
    foreach ($name in $names) {
        if (Rule-Owned $name) { $policy.Rules.Remove($name) }
        if (Rule-Owned $name) { throw 'test.firewall_rule_remained' }
    }
    $plan.ownedRules = @()
    $plan.pendingRules = @()
    Save-Ownership
}
function Seal-Expired {
    if (-not (Test-Path -LiteralPath $expired)) {
        $stream = [IO.File]::Open($expired, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stream.Dispose()
    }
}
function Check-Script {
    $hash = (Get-FileHash -LiteralPath $plan.script -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $plan.scriptHash) { throw 'test.firewall_script_changed' }
}
function Check-Identity {
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $plan.corePID)
    if ($null -eq $process -or $process.ParentProcessId -ne $plan.parentPID -or
        -not [string]::Equals($process.ExecutablePath, $plan.executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'test.firewall_process_identity_changed' }
    $hash = (Get-FileHash -LiteralPath $plan.executable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $plan.coreHash) { throw 'test.firewall_executable_changed' }
    $creation = $process.CreationDate.ToUniversalTime().ToString('o')
    if ($plan.creationUtc -eq '') {
        if ($Operation -ne 'setup') { throw 'test.firewall_creation_time_missing' }
        $plan.creationUtc = $creation
        Save-Record $PlanPath $plan
    }
    elseif ($plan.creationUtc -ne $creation) { throw 'test.firewall_process_replaced' }
    $proof.identityVerified = $true
}
function Check-NetworkPolicy {
    $profiles = $policy.CurrentProfileTypes
    if ($profiles -lt 1 -or $profiles -gt 7) { throw 'test.firewall_active_profile_unknown' }
    foreach ($profile in @(1, 2, 4)) {
        if (($profiles -band $profile) -eq 0) { continue }
        if (-not $policy.FirewallEnabled($profile)) { throw 'test.firewall_active_profile_disabled' }
        $excluded = @($policy.ExcludedInterfaces($profile) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($excluded.Count -ne 0) { throw 'test.firewall_excluded_interface_unsupported' }
    }
    if ($policy.LocalPolicyModifyState -ne 0) { throw 'test.firewall_local_policy_not_effective' }
}
function Watchdog-Arguments {
    $script = $plan.script.Replace("'", "''")
    $config = $PlanPath.Replace("'", "''")
    $text = "`$ProgressPreference='SilentlyContinue'; & ([ScriptBlock]::Create([IO.File]::ReadAllText('$script'))) -PlanPath '$config' -Operation 'watchdog'"
    return '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text))
}
function Read-Task {
    $tasks = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq $taskName })
    if ($tasks.Count -gt 1) { throw 'test.firewall_task_ambiguous' }
    if ($tasks.Count -eq 0) { return $null }
    return $tasks[0]
}
function Task-Owned {
    if ($plan.taskState -eq 'none') { return $null }
    $task = Read-Task
    if ($null -ne $task -and $task.Description -ne ('Isolated DSHKer UDP guard ' + $plan.id + ' root=' + $root)) { throw 'test.firewall_task_ownership_lost' }
    return $task
}
function Check-Guard([long]$requiredMilliseconds) {
    if ((Test-Path -LiteralPath $expired) -or ([DateTime]::UtcNow.AddMilliseconds($requiredMilliseconds + 15000) -ge $deadline)) { throw 'test.firewall_guard_expired' }
    $task = Task-Owned
    $powerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    if ($null -eq $task -or $task.State -eq 'Disabled' -or $task.Actions.Count -ne 1 -or
        $task.Actions[0].Execute -ne $powerShell -or $task.Actions[0].Arguments -ne (Watchdog-Arguments) -or
        $task.Principal.LogonType -ne 'S4U' -or $task.Principal.RunLevel -ne 'Highest' -or
        $task.Settings.RunOnlyIfNetworkAvailable -or $task.Settings.RunOnlyIfIdle -or
        $task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) { throw 'test.firewall_guard_changed' }
    $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
    if ($info.NextRunTime.ToUniversalTime() -lt [DateTime]::UtcNow.AddMilliseconds($requiredMilliseconds + 15000)) { throw 'test.firewall_guard_not_future' }
}
function Add-Rule([string]$name, [int]$direction) {
    if ($null -ne (Read-Rule $name)) { throw 'test.firewall_name_conflict' }
    $plan.pendingRules = @($plan.pendingRules) + @($name)
    Save-Ownership
    $rule = New-Object -ComObject HNetCfg.FWRule
    $rule.Name = $name
    $rule.Description = 'Isolated DSHKer UDP fault ' + $plan.id + ' root=' + $root
    $rule.ApplicationName = $plan.executable
    $rule.Protocol = 17
    $rule.LocalPorts = '*'
    $rule.RemotePorts = '*'
    $rule.LocalAddresses = '*'
    $rule.RemoteAddresses = '*'
    $rule.Direction = $direction
    $rule.Action = 0
    $rule.Profiles = 7
    $rule.InterfaceTypes = 'All'
    $rule.Enabled = $false
    $policy.Rules.Add($rule)
    $read = Read-Rule $name
    if ($null -eq $read -or $read.ApplicationName -ne $plan.executable -or $read.Protocol -ne 17 -or
        $read.LocalPorts -ne '*' -or $read.RemotePorts -ne '*' -or $read.Direction -ne $direction -or
        $read.Action -ne 0 -or $read.Enabled -or $read.Profiles -ne 7 -or -not [string]::IsNullOrEmpty($read.ServiceName)) { throw 'test.firewall_rule_readback_failed' }
    $plan.ownedRules = @($plan.ownedRules) + @($name)
    $plan.pendingRules = @($plan.pendingRules | Where-Object { $_ -cne $name })
    Save-Ownership
}
function Setup-Guard {
    Check-Script
    Check-Identity
    if ($null -ne (Read-Task)) { throw 'test.firewall_task_conflict' }
    foreach ($name in $names) { if ($null -ne (Read-Rule $name)) { throw 'test.firewall_name_conflict' } }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity.User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    $action = New-ScheduledTaskAction -Execute (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -Argument (Watchdog-Arguments)
    $trigger = New-ScheduledTaskTrigger -Once -At $deadline.ToLocalTime()
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 30)
    $plan.taskState = 'pending'
    Save-Ownership
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Description ('Isolated DSHKer UDP guard ' + $plan.id + ' root=' + $root) -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    $plan.taskState = 'owned'
    Save-Ownership
    With-Lock { Add-Rule $names[2] 1 }
    $requestedAt = [DateTime]::UtcNow
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    $wait = [Diagnostics.Stopwatch]::StartNew()
    while ($wait.Elapsed.TotalSeconds -lt 15) {
        $task = Read-Task
        $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
        if ((Test-Path -LiteralPath $proofFile) -and $task.State -ne 'Running' -and
            $info.LastRunTime.ToUniversalTime() -ge $requestedAt.AddSeconds(-1) -and $info.LastTaskResult -eq 0) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($wait.Elapsed.TotalSeconds -ge 15) { throw 'test.firewall_watchdog_proof_timeout' }
    $receipt = [IO.File]::ReadAllText($proofFile) | ConvertFrom-Json
    if ($receipt.id -ne $plan.id -or $receipt.kind -ne 'independent-proof' -or $null -ne (Read-Rule $names[2])) { throw 'test.firewall_watchdog_proof_failed' }
    Check-Guard 35000
}
function Invoke-Watchdog {
    Check-Script
    With-Lock {
        $active = @($names[0..1] | Where-Object { $null -ne (Read-Rule $_) })
        if ([DateTime]::UtcNow -lt $deadline -and $active.Count -eq 0 -and -not (Test-Path -LiteralPath $expired)) {
            Remove-Rules
            Save-Record $proofFile @{ id = $plan.id; kind = 'independent-proof'; at = [DateTime]::UtcNow.ToString('o') }
        }
        else {
            Seal-Expired
            Remove-Rules
            Save-Record $receiptFile @{ id = $plan.id; kind = 'deadline-cleanup'; at = [DateTime]::UtcNow.ToString('o'); activeRules = 0 }
        }
    }
}
function Invoke-Cut {
    if ($Direction -eq 'none' -or ($Milliseconds -ne 3000 -and $Milliseconds -ne 35000)) { throw 'test.firewall_invalid_fault' }
    Check-Script
    Check-Identity
    Check-NetworkPolicy
    $selected = @()
    if ($Direction -eq 'inbound' -or $Direction -eq 'both') { $selected += $names[0] }
    if ($Direction -eq 'outbound' -or $Direction -eq 'both') { $selected += $names[1] }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        With-Lock {
            Check-Guard $Milliseconds
            foreach ($name in $selected) { Add-Rule $name $(if ($name -eq $names[0]) { 1 } else { 2 }) }
            Check-Guard $Milliseconds
            foreach ($name in $selected) { (Read-Rule $name).Enabled = $true }
            foreach ($name in $selected) { if (-not (Read-Rule $name).Enabled) { throw 'test.firewall_enable_failed' } }
            $watch.Restart()
        }
        $remaining = $Milliseconds - $watch.ElapsedMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
        $proof.heldMilliseconds = $watch.ElapsedMilliseconds
    }
    catch { $proof.errorCode = 'test.firewall_operation_failed:' + $_.FullyQualifiedErrorId }
    finally {
        $proof.releaseStartedAt = [DateTime]::UtcNow.ToString('o')
        try {
            With-Lock { Remove-Rules }
            $proof.releasedAt = [DateTime]::UtcNow.ToString('o')
        }
        catch { $proof.cleanupError = 'test.firewall_cleanup_failed:' + $_.FullyQualifiedErrorId }
    }
}
function Close-Guard {
    With-Lock { Seal-Expired; Remove-Rules }
    $task = Task-Owned
    if ($null -ne $task) {
        Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
        $wait = [Diagnostics.Stopwatch]::StartNew()
        while ((Read-Task).State -eq 'Running' -and $wait.Elapsed.TotalSeconds -lt 10) { Start-Sleep -Milliseconds 100 }
        if ((Read-Task).State -eq 'Running') { throw 'test.firewall_watchdog_still_running' }
        Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
        if ($null -ne (Read-Task)) { throw 'test.firewall_task_remained' }
    }
    $plan.taskState = 'none'
    Save-Ownership
    $proof.cleanupConfirmed = $true
}
try {
    switch ($Operation) {
        'setup' { Setup-Guard }
        'cut' { Invoke-Cut }
        'close' { Close-Guard }
        'watchdog' { Invoke-Watchdog }
        'probe' {
            Check-Guard 0
            With-Lock { Add-Rule $names[2] 1 }
            Save-Record (Join-Path $root 'probe-ready.json') @{ id = $plan.id; controllerPID = $PID; at = [DateTime]::UtcNow.ToString('o') }
            Start-Sleep -Seconds 120
        }
    }
}
catch {
    if ($proof.errorCode -eq '') { $proof.errorCode = 'test.firewall_operation_failed:' + $_.FullyQualifiedErrorId }
    if ($Operation -ne 'watchdog') {
        try { With-Lock { Remove-Rules } }
        catch { if ($proof.cleanupError -eq '') { $proof.cleanupError = 'test.firewall_cleanup_failed:' + $_.FullyQualifiedErrorId } }
    }
}
finally {
    try { With-Lock { $proof.activeRules = @($names | Where-Object { Rule-Owned $_ }).Count } }
    catch { $proof.activeRules = -1; $proof.cleanupError = 'test.firewall_readback_failed' }
    $mutex.Dispose()
}
$proof | ConvertTo-Json -Depth 5 -Compress
if ($proof.errorCode -ne '' -or $proof.cleanupError -ne '' -or $proof.activeRules -ne 0) { exit 1 }
