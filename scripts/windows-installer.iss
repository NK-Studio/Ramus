; Windows 설치 마법사(Inno Setup 6). 릴리즈 워크플로가 zip 에 담는 것과 같은 폴더(Ramus.exe · git · README.md)를 설치한다.
;
;   ISCC /DAppVersion=1.6.0 /DSourceDir=<Ramus.exe 가 든 폴더> /DOutputDir=<출력 폴더> /DOutputName=<파일 이름(.exe 제외)> scripts\windows-installer.iss
;
; 첫 화면에서 "나만 설치(관리자 권한 없이 %LOCALAPPDATA%\Programs)"와 "모든 사용자(Program Files)"를 고른다.

#ifndef AppVersion
  #error AppVersion 을 /DAppVersion=1.2.3 으로 넘겨야 합니다
#endif
#ifndef SourceDir
  #error SourceDir 을 /DSourceDir=<폴더> 로 넘겨야 합니다
#endif
#ifndef OutputDir
  #define OutputDir "..\target\installer"
#endif
#ifndef OutputName
  #define OutputName "Ramus-" + AppVersion + "-windows-x64-setup"
#endif

[Setup]
; AppId 는 업그레이드·제거가 같은 앱으로 알아보는 값이다. 절대 바꾸지 않는다.
AppId={{053E3259-B1A9-4AE5-9B4B-9648F753F6FF}
AppName=Ramus
AppVersion={#AppVersion}
AppVerName=Ramus {#AppVersion}
AppPublisher=NK Studio
AppPublisherURL=https://github.com/NK-Studio/Ramus
AppSupportURL=https://github.com/NK-Studio/Ramus/issues
AppUpdatesURL=https://github.com/NK-Studio/Ramus/releases
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Ramus
VersionInfoDescription=Ramus Setup
VersionInfoCompany=NK Studio
VersionInfoCopyright=Public domain (The Unlicense)

; 기본은 관리자 권한 없는 사용자 설치, 첫 화면에서 모든 사용자 설치로 바꿀 수 있다.
; {autopf} 는 사용자 설치면 %LOCALAPPDATA%\Programs, 모든 사용자 설치면 Program Files 가 된다.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\Ramus
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

WizardStyle=modern
SetupIconFile=..\assets\icon\ramus.ico
UninstallDisplayIcon={app}\Ramus.exe
UninstallDisplayName=Ramus
; 업그레이드할 때 실행 중인 Ramus(와 내장 git)를 닫았다가 설치 뒤 다시 띄운다.
CloseApplications=yes
RestartApplications=yes

OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/max
SolidCompression=yes

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; 내장 git 을 올리면 파일 구성이 바뀐다 — 예전 판의 남은 파일이 섞이지 않게 통째로 지우고 새로 넣는다.
Type: filesandordirs; Name: "{app}\git"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Ramus"; Filename: "{app}\Ramus.exe"
Name: "{autodesktop}\Ramus"; Filename: "{app}\Ramus.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Ramus.exe"; Description: "{cm:LaunchProgram,Ramus}"; Flags: nowait postinstall skipifsilent
