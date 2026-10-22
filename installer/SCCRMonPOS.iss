#ifndef ReleaseDir
  #error Pass /DReleaseDir with a verified release directory.
#endif
#ifndef ReleaseVersion
  #error Pass /DReleaseVersion with the release version.
#endif

[Setup]
#ifdef TestAppId
AppId={#TestAppId}
#else
AppId={{38946E4C-2EE5-446C-96ED-EFC9B96F4C54}
#endif
AppName=SCCRM POS Companion
AppVersion={#ReleaseVersion}
AppVerName=SCCRM POS Companion {#ReleaseVersion}
AppPublisher=SC Drugstore
AppPublisherURL=https://github.com/AKCD1998/SCCRMonPOS
AppSupportURL=https://github.com/AKCD1998/SCCRMonPOS
DefaultDirName={localappdata}\Programs\SCCRMonPOS
DefaultGroupName=SCCRM
PrivilegesRequired=lowest
DisableWelcomePage=no
DisableDirPage=no
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
WizardStyle=modern light
WizardImageFile=Assets\wizard-side.png
WizardSmallImageFile=Assets\wizard-logo.png
SetupIconFile=Assets\sc.ico
UninstallDisplayIcon={app}\sc.ico
UninstallDisplayName=SCCRM POS Companion
#ifdef TestAppId
AppMutex=Global\{#TestAppId}_App
SetupMutex=Global\{#TestAppId}_Setup
#else
AppMutex=Global\SCCRMonPOS_SingleInstance
SetupMutex=Global\SCCRMonPOS_Setup
#endif
CloseApplications=no
RestartApplications=no
MinVersion=6.1sp1
#ifdef TestAppId
OutputBaseFilename=SCCRMonPOS-Setup-TEST-{#ReleaseVersion}
#else
OutputBaseFilename=SCCRMonPOS-Setup-{#ReleaseVersion}
#endif
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
VersionInfoCompany=SC Drugstore
VersionInfoDescription=SCCRM POS Companion Setup

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startwithwindows"; Description: "Start SCCRM when I sign in to Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#ReleaseDir}\SCCRMonPOS.exe"; DestDir: "{tmp}"; DestName: "SCCRMonPOS-DeviceCheck.exe"; Flags: dontcopy
Source: "{#ReleaseDir}\SCCRMonPOS.exe"; DestDir: "{app}"; Flags: ignoreversion
; The bundled connection helper creates/merges configuration after a successful
; SELECT-only connection check. Neither configuration nor runtime data is uninstalled.
Source: "Assets\sc.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "Getting-started.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\SCCRM"; Filename: "{app}\SCCRMonPOS.exe"; WorkingDir: "{app}"; IconFilename: "{app}\sc.ico"
Name: "{userdesktop}\SCCRM"; Filename: "{app}\SCCRMonPOS.exe"; WorkingDir: "{app}"; IconFilename: "{app}\sc.ico"; Tasks: desktopicon
Name: "{userstartup}\SCCRM"; Filename: "{app}\SCCRMonPOS.exe"; WorkingDir: "{app}"; IconFilename: "{app}\sc.ico"; Tasks: startwithwindows

[Run]
Filename: "{app}\SCCRMonPOS.exe"; Description: "Open SCCRM POS Companion"; Flags: nowait postinstall skipifsilent

[Messages]
WelcomeLabel1=Welcome to the SCCRM Setup Wizard
WelcomeLabel2=This will install SCCRM POS Companion on your computer.%n%nRegister and find members, or let customers scan a QR code on the customer display.
FinishedLabel=Setup has installed SCCRM and verified its read-only AdaPos connection.%n%nOpen SCCRM and use your existing staff PIN to sign in. Press Ctrl+Alt+Q for membership tools.%n%nFuture app updates remain optional.

[Code]
function InitializeSetup: Boolean;
var
  DeviceResult: Integer;
begin
  Result := IsDotNetInstalled(net48, 0);
  if not Result then
    SuppressibleMsgBox('SCCRM needs Microsoft .NET Framework 4.8 or later.' + #13#10 +
      'Please install it, then run Setup again.', mbError, MB_OK, IDOK);
  if not Result then Exit;
  ExtractTemporaryFile('SCCRMonPOS-DeviceCheck.exe');
  Result := Exec(ExpandConstant('{tmp}\SCCRMonPOS-DeviceCheck.exe'), '--check-device', '', SW_HIDE, ewWaitUntilTerminated, DeviceResult);
  { A legacy EXE ignores --check-device and exits 0; it must never authorize Setup. }
  if Result then Result := DeviceResult = 42;
  if not Result then
    SuppressibleMsgBox('This computer is not approved for SCCRM.' + #13#10 +
      'Connect to the company Tailscale network. The approved device identity and AdaSoftware installation must both match. Contact your administrator.', mbError, MB_OK, IDOK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  SetupResult: Integer;
  SetupArgs: String;
begin
  Result := '';
  SetupArgs := '--setup-adapos "' + ExpandConstant('{app}') + '"';
  if WizardSilent then SetupArgs := SetupArgs + ' --silent';
  if not Exec(ExpandConstant('{tmp}\SCCRMonPOS-DeviceCheck.exe'), SetupArgs, '', SW_SHOWNORMAL, ewWaitUntilTerminated, SetupResult) then
    Result := 'Could not start AdaPos connection setup. No application files were installed.'
  else if SetupResult <> 43 then
    Result := 'AdaPos connection setup did not complete. Close SCCRM and check the read-only database connection, then try again.';
end;
