; Vayrone PostMaster — Windows installer (Inno Setup 6, https://jrsoftware.org/isinfo.php)
;
; Built by scripts/package-windows.mjs, which prepares:
;   release\win-x64\             program (bin\vpm.exe, db, web), built on Windows with --format sea
;   .cache\win\mariadb\          portable MariaDB (bin, lib, share)
;   .cache\win\WinSW-x64.exe     service wrapper
; and runs:  ISCC /DAppVersion=0.3.0 installer\windows\vayrone-postmaster.iss
;
; Installs to   C:\Program Files\Vayrone PostMaster
; Config + key  C:\ProgramData\Vayrone PostMaster  (vpm.config.json, master.key.dpapi)
; Mail data     chosen on a wizard page (default C:\ProgramData\Vayrone PostMaster\data)
; Services      VayronePostMasterDB (MariaDB, 127.0.0.1:3307), VayronePostMaster, VayronePostMasterWorker,
;               VayronePostMasterUpdater (applies updates requested in the admin panel)
; Supported     Windows 10/11, Windows Server 2016 or later, 64-bit

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define Root "..\.."
#define DbPort "3307"

[Setup]
AppId={{7D3B6E4A-2C51-4F8E-9A1B-5E0C3D7F9A21}
AppName=Vayrone PostMaster
AppVersion={#AppVersion}
AppVerName=Vayrone PostMaster {#AppVersion}
AppPublisher=Vayrone Infratech
AppPublisherURL=https://vayrone.com
AppSupportURL=https://vayrone.com/support
AppCopyright=Copyright (C) Vayrone Infratech, Agra, India
VersionInfoDescription=Vayrone PostMaster by Vayrone Infratech — Setup
VersionInfoCompany=Vayrone Infratech
DefaultDirName={autopf}\Vayrone PostMaster
DefaultGroupName=Vayrone PostMaster
DisableProgramGroupPage=yes
OutputDir={#Root}\dist
OutputBaseFilename=VayronePostMaster-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.14393
PrivilegesRequired=admin
WizardStyle=modern
LicenseFile=assets\EULA.txt
UninstallDisplayName=Vayrone PostMaster
UninstallDisplayIcon={app}\bin\vpm.exe
CloseApplications=no
SetupLogging=yes
#ifexist "assets\vpm.ico"
SetupIconFile=assets\vpm.ico
#endif
#ifexist "assets\wizard.bmp"
WizardImageFile=assets\wizard.bmp
#endif
; Code signing (Phase 10): ISCC /Ssigntool="signtool.exe sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 $f"
#ifdef SignTool
SignTool=signtool
#endif

[Messages]
WelcomeLabel1=Vayrone PostMaster by Vayrone Infratech
WelcomeLabel2=This installs Vayrone PostMaster {#AppVersion}, the LAN mail server for your office.%n%nAfter installation a browser opens the setup wizard: licence, company details, mail domains, administrator, relay account, network and backups.

[Files]
Source: "{#Root}\release\win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; MariaDB is installed with the first installation only; upgrades leave the database engine running.
Source: "{#Root}\.cache\win\mariadb\*"; DestDir: "{app}\mariadb"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: not IsUpgrade
Source: "{#Root}\.cache\win\WinSW-x64.exe"; DestDir: "{app}\service"; DestName: "VayronePostMaster.exe"; Flags: ignoreversion
Source: "{#Root}\.cache\win\WinSW-x64.exe"; DestDir: "{app}\service"; DestName: "VayronePostMasterWorker.exe"; Flags: ignoreversion
Source: "{#Root}\.cache\win\WinSW-x64.exe"; DestDir: "{app}\service"; DestName: "VayronePostMasterUpdater.exe"; Flags: ignoreversion
Source: "{#Root}\.cache\win\WinSW-LICENSE.txt"; DestDir: "{app}\service"; DestName: "WinSW-LICENSE.txt"; Flags: ignoreversion
Source: "winsw\VayronePostMaster.xml"; DestDir: "{app}\service"; Flags: ignoreversion; AfterInstall: FillServiceXml('VayronePostMaster.xml')
Source: "winsw\VayronePostMasterWorker.xml"; DestDir: "{app}\service"; Flags: ignoreversion; AfterInstall: FillServiceXml('VayronePostMasterWorker.xml')
Source: "winsw\VayronePostMasterUpdater.xml"; DestDir: "{app}\service"; Flags: ignoreversion; AfterInstall: FillServiceXml('VayronePostMasterUpdater.xml')

[Dirs]
Name: "{commonappdata}\Vayrone PostMaster"; Permissions: admins-full system-full

[INI]
Filename: "{group}\Vayrone PostMaster admin.url"; Section: "InternetShortcut"; Key: "URL"; String: "{code:AdminUrl}"

[Icons]
Name: "{group}\Show setup wizard address"; Filename: "{cmd}"; Parameters: "/k ""{app}\bin\vpm.exe"" setup-token"; Comment: "Shows the setup wizard address while setup is not finished"
Name: "{group}\Vayrone PostMaster command prompt"; Filename: "{cmd}"; Parameters: "/k cd /d ""{app}\bin"" && vpm.exe"; WorkingDir: "{app}\bin"
Name: "{group}\Third-party licences"; Filename: "{app}\THIRD_PARTY_LICENSES.md"
Name: "{group}\Uninstall Vayrone PostMaster"; Filename: "{uninstallexe}"

[Run]
Filename: "{code:SetupUrl}"; Description: "Open the setup wizard"; Flags: postinstall shellexec nowait skipifsilent; Check: HasSetupUrl

[UninstallRun]
Filename: "{app}\service\VayronePostMasterUpdater.exe"; Parameters: "stop"; Flags: runhidden; RunOnceId: "StopUpdater"
Filename: "{app}\service\VayronePostMasterUpdater.exe"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "RemoveUpdater"
Filename: "{app}\service\VayronePostMasterWorker.exe"; Parameters: "stop"; Flags: runhidden; RunOnceId: "StopWorker"
Filename: "{app}\service\VayronePostMasterWorker.exe"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "RemoveWorker"
Filename: "{app}\service\VayronePostMaster.exe"; Parameters: "stop"; Flags: runhidden; RunOnceId: "StopCore"
Filename: "{app}\service\VayronePostMaster.exe"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "RemoveCore"
Filename: "{sys}\sc.exe"; Parameters: "stop VayronePostMasterDB"; Flags: runhidden; RunOnceId: "StopDb"
Filename: "{sys}\sc.exe"; Parameters: "delete VayronePostMasterDB"; Flags: runhidden; RunOnceId: "RemoveDb"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Vayrone PostMaster"""; Flags: runhidden; RunOnceId: "RemoveFirewall"

[Code]
var
  DataPage: TInputDirWizardPage;
  PortPage: TInputQueryWizardPage;
  SetupUrlValue: String;

function ConfigDir(): String;
begin
  Result := ExpandConstant('{commonappdata}\Vayrone PostMaster');
end;

function ConfigFile(): String;
begin
  Result := ConfigDir() + '\vpm.config.json';
end;

function IsUpgrade(): Boolean;
begin
  Result := FileExists(ConfigFile());
end;

function DataDir(): String;
var
  S: String;
begin
  if RegQueryStringValue(HKLM, 'Software\Vayrone\PostMaster', 'DataDir', S) and (S <> '') then
    Result := S
  else if DataPage <> nil then
    Result := DataPage.Values[0]
  else
    Result := ConfigDir() + '\data';
end;

function WebPort(): String;
var
  S: String;
begin
  if RegQueryStringValue(HKLM, 'Software\Vayrone\PostMaster', 'WebPort', S) and (S <> '') then
    Result := S
  else if PortPage <> nil then
    Result := Trim(PortPage.Values[0])
  else
    Result := '443';
end;

function AdminUrl(Param: String): String;
begin
  if WebPort() = '443' then
    Result := 'https://localhost/'
  else
    Result := 'https://localhost:' + WebPort() + '/';
end;

function SetupUrl(Param: String): String;
begin
  Result := SetupUrlValue;
end;

function HasSetupUrl(): Boolean;
begin
  Result := SetupUrlValue <> '';
end;

function PortInUse(Port: String): Boolean;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/c netstat -ano -p TCP | findstr /R /C:":' + Port + ' .*LISTENING"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := Code = 0;
end;

procedure InitializeWizard();
var
  DefaultPort: String;
begin
  if IsUpgrade() then exit;
  DataPage := CreateInputDirPage(wpSelectDir, 'Mail data folder', 'Where should Vayrone PostMaster store mail, the database and search index?',
    'Choose a disk with plenty of free space (plan about 1 GB per user per year). Backups should go to a different disk; you choose that in the setup wizard.',
    False, '');
  DataPage.Add('Mail data folder:');
  DataPage.Values[0] := ConfigDir() + '\data';
  DefaultPort := '443';
  if PortInUse('443') then DefaultPort := '8443';
  PortPage := CreateInputQueryPage(DataPage.ID, 'Web admin port', 'HTTPS port for the web admin and webmail',
    'Port 443 is the standard HTTPS port. If IIS or another web server already uses it, keep 8443. Mail ports (SMTP, IMAP, POP3) are set in the setup wizard.');
  PortPage.Add('HTTPS port:', False);
  PortPage.Values[0] := DefaultPort;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;
  if (PortPage <> nil) and (CurPageID = PortPage.ID) then begin
    P := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if (P < 1) or (P > 65535) then begin
      MsgBox('Enter a port number between 1 and 65535.', mbError, MB_OK);
      Result := False;
    end else if PortInUse(Trim(PortPage.Values[0])) then begin
      Result := MsgBox('Port ' + Trim(PortPage.Values[0]) + ' is already in use by another program. Use it anyway?', mbConfirmation, MB_YESNO) = IDYES;
    end;
  end;
end;

procedure FillServiceXml(Name: String);
var
  F: String;
  S: AnsiString;
  U: String;
begin
  F := ExpandConstant('{app}\service\') + Name;
  if LoadStringFromFile(F, S) then begin
    U := String(S);
    StringChangeEx(U, '@CONFIG@', ConfigFile(), True);
    StringChangeEx(U, '@LOGS@', DataDir() + '\logs', True);
    SaveStringToFile(F, AnsiString(U), False);
  end;
end;

function RunHidden(const Exe, Params: String; const What: String): Boolean;
var
  Code: Integer;
begin
  Result := Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
  Log(What + ': exit ' + IntToStr(Code));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  // Upgrades: stop the program services; the database keeps running.
  if IsUpgrade() then begin
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop VayronePostMasterUpdater', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop VayronePostMasterWorker', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop VayronePostMaster', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(3000);
  end;
end;

function ReadLine(const FileName, Prefix: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(FileName, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      if Pos(Prefix, Lines[I]) = 1 then Result := Trim(Copy(Lines[I], Length(Prefix) + 1, 1000));
end;

function FirstLine(const FileName: String): String;
var
  Lines: TArrayOfString;
begin
  Result := '';
  if LoadStringsFromFile(FileName, Lines) and (GetArrayLength(Lines) > 0) then Result := Trim(Lines[0]);
end;

procedure FirstInstall();
var
  App, Data, Vpm, Pw, Tmp, MyIni, Log: String;
  Code: Integer;
begin
  App := ExpandConstant('{app}');
  Data := DataDir();
  Vpm := App + '\bin\vpm.exe';
  Tmp := ExpandConstant('{tmp}\secret.txt');
  Log := ConfigDir() + '\install.log';
  ForceDirectories(Data);
  ForceDirectories(Data + '\logs');
  // Only administrators and the services (LocalSystem) may read mail and configuration.
  // Set before MariaDB creates its folder, so it can still grant its own service account.
  RunHidden(ExpandConstant('{sys}\icacls.exe'), '"' + Data + '" /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F', 'icacls data');
  RunHidden(ExpandConstant('{sys}\icacls.exe'), '"' + ConfigDir() + '" /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F', 'icacls config');

  WizardForm.StatusLabel.Caption := 'Preparing the database...';
  // Root password for the bundled MariaDB (crypto-random), kept for support in an admins-only file.
  Exec(ExpandConstant('{cmd}'), '/c ""' + Vpm + '" gen-secret 24 > "' + Tmp + '""', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Pw := FirstLine(Tmp);
  DeleteFile(Tmp);
  if Length(Pw) < 20 then RaiseException('Could not generate the database password.');
  if not RunHidden(App + '\mariadb\bin\mariadb-install-db.exe',
      '--datadir="' + Data + '\db" --service=VayronePostMasterDB --port={#DbPort} --password="' + Pw + '"', 'mariadb-install-db') then
    RaiseException('The database could not be initialised. See the setup log.');
  MyIni := Data + '\db\my.ini';
  SaveStringToFile(MyIni, #13#10 + '[mysqld]' + #13#10 + 'bind-address=127.0.0.1' + #13#10 + 'character-set-server=utf8mb4' + #13#10 +
    'collation-server=utf8mb4_unicode_ci' + #13#10 + 'innodb_buffer_pool_size=512M' + #13#10 + 'max_allowed_packet=128M' + #13#10, True);
  SaveStringToFile(ConfigDir() + '\mariadb-root.txt', 'MariaDB root password for the bundled database (port {#DbPort}, 127.0.0.1 only):' + #13#10 + Pw + #13#10, False);
  RunHidden(ExpandConstant('{sys}\icacls.exe'), '"' + ConfigDir() + '\mariadb-root.txt" /inheritance:r /grant:r *S-1-5-32-544:F *S-1-5-18:F', 'icacls root password');
  RunHidden(ExpandConstant('{sys}\sc.exe'), 'config VayronePostMasterDB start= auto DisplayName= "Vayrone PostMaster Database"', 'sc config db');
  if not RunHidden(ExpandConstant('{sys}\net.exe'), 'start VayronePostMasterDB', 'start db') then
    RaiseException('The database service did not start. See the setup log.');

  WizardForm.StatusLabel.Caption := 'Creating the mail database...';
  if not RunHidden(ExpandConstant('{cmd}'),
      '/c "set "VPM_DB_ADMIN_PASSWORD=' + Pw + '" && "' + Vpm + '" init --home "' + App + '" --config "' + ConfigFile() + '" --data "' + Data +
      '" --dpapi --master-key "' + ConfigDir() + '\master.key.dpapi" --db-host 127.0.0.1 --db-port {#DbPort} --db-admin-user root --web-port ' + WebPort() +
      ' --hostname ' + GetComputerNameString() + ' > "' + Log + '" 2>&1"', 'vpm init') then
    RaiseException('Setting up the mail database failed. See ' + Log);
  SetupUrlValue := ReadLine(Log, 'Open the setup wizard: ');
  // The setup wizard is opened locally, where no token is needed.
  if SetupUrlValue <> '' then SetupUrlValue := AdminUrl('') + 'setup';

  RegWriteStringValue(HKLM, 'Software\Vayrone\PostMaster', 'DataDir', Data);
  RegWriteStringValue(HKLM, 'Software\Vayrone\PostMaster', 'WebPort', WebPort());
end;

var
  WasUpgrade: Boolean;

function InitializeSetup(): Boolean;
begin
  // Decided once: FirstInstall writes the config file, after which IsUpgrade() is true.
  WasUpgrade := IsUpgrade();
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  App: String;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then exit;
  App := ExpandConstant('{app}');
  if not WasUpgrade then FirstInstall();

  WizardForm.StatusLabel.Caption := 'Installing services...';
  // "install" fails harmlessly when the service already exists (upgrades).
  RunHidden(App + '\service\VayronePostMaster.exe', 'install', 'install core');
  RunHidden(App + '\service\VayronePostMasterWorker.exe', 'install', 'install worker');
  RunHidden(App + '\service\VayronePostMasterUpdater.exe', 'install', 'install updater');
  RunHidden(App + '\service\VayronePostMaster.exe', 'start', 'start core');
  RunHidden(App + '\service\VayronePostMasterWorker.exe', 'start', 'start worker');
  RunHidden(App + '\service\VayronePostMasterUpdater.exe', 'start', 'start updater');

  WizardForm.StatusLabel.Caption := 'Opening the firewall...';
  Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Vayrone PostMaster"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  RunHidden(ExpandConstant('{sys}\netsh.exe'),
    'advfirewall firewall add rule name="Vayrone PostMaster" dir=in action=allow protocol=TCP localport=' + WebPort() + ',587,465,143,993,110,995 profile=domain,private',
    'firewall');
  // Give the service a moment to open its port before the browser starts.
  Sleep(4000);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    MsgBox('Vayrone PostMaster was removed. Your mail data, the database and the configuration (with the encryption key) were kept in:' + #13#10 +
      DataDir() + #13#10 + ConfigDir() + #13#10#13#10 + 'Delete these folders yourself only if you no longer need the mail.', mbInformation, MB_OK);
end;
