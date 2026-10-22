# Updating an app must not terminate its independent runtime owner or DSH child.
# The installer only observes its own exact directory; the user owns normal Quit.
!macro customHeader
  LangString dshkerRuntimeStillRunning ${LANG_ENGLISH} "${PRODUCT_NAME} or its managed runtime is still running. Quit the application normally, then choose Retry. This installer will not terminate processes."
  LangString dshkerRuntimeStillRunning ${LANG_SIMPCHINESE} "${PRODUCT_NAME} 或其托管运行时仍在运行。请正常退出应用，再选择重试。安装程序不会终止进程。"
  LangString dshkerRuntimeCheckFailed ${LANG_ENGLISH} "The installer could not safely verify running application processes. Installation has stopped without terminating any process."
  LangString dshkerRuntimeCheckFailed ${LANG_SIMPCHINESE} "安装程序无法安全确认应用进程状态，已停止安装，未终止任何进程。"
!macroend

!macro customCheckAppRunning
  # Pass a selected directory as data, never interpolate it into PowerShell code.
  System::Call 'kernel32::SetEnvironmentVariable(t "DSHKER_INSTALL_GUARD_ROOT", t "$INSTDIR") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSHKER_INSTALL_GUARD_EXE", t "${APP_EXECUTABLE_FILENAME}") i.r0'
  System::Call 'kernel32::GetCurrentProcessId() i.r2'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSHKER_INSTALL_GUARD_PID", t "$2") i.r0'
  dshker_guard_retry:
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "try { $$root=[IO.Path]::GetFullPath($$env:DSHKER_INSTALL_GUARD_ROOT); $$prefix=$$root.TrimEnd([char]92,[char]47)+[IO.Path]::DirectorySeparatorChar; $$own=[int]$$env:DSHKER_INSTALL_GUARD_PID; $$all=@(Get-CimInstance Win32_Process -ErrorAction Stop); $$unknown=@($$all | Where-Object { $$_.ProcessId -ne $$own -and -not $$_.ExecutablePath -and ($$_.Name -eq $$env:DSHKER_INSTALL_GUARD_EXE -or $$_.Name -eq 'dshkerd.exe') }); if ($$unknown.Count -gt 0) { exit 2 }; $$active=@($$all | Where-Object { $$_.ProcessId -ne $$own -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$prefix,[StringComparison]::OrdinalIgnoreCase) }); if ($$active.Count -gt 0) { exit 10 }; exit 0 } catch { exit 2 }"`
    Pop $0
    ${If} $0 == 0
      Goto dshker_guard_done
    ${ElseIf} $0 == 10
      IfSilent dshker_guard_abort
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(dshkerRuntimeStillRunning)" /SD IDCANCEL IDRETRY dshker_guard_retry
      Goto dshker_guard_abort
    ${Else}
      IfSilent dshker_guard_abort
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(dshkerRuntimeCheckFailed)" /SD IDOK
      Goto dshker_guard_abort
    ${EndIf}
  dshker_guard_abort:
    SetErrorLevel 10
    Quit
  dshker_guard_done:
    System::Call 'kernel32::SetEnvironmentVariable(t "DSHKER_INSTALL_GUARD_ROOT", p 0) i.r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "DSHKER_INSTALL_GUARD_EXE", p 0) i.r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "DSHKER_INSTALL_GUARD_PID", p 0) i.r0'
!macroend
