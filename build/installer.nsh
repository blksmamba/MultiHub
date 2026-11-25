!include LogicLib.nsh

!macro customInstall
  ExecWait '"$INSTDIR\MultiHubExplorer.exe" --install' $0
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ExecWait '"$INSTDIR\MultiHubExplorer.exe" --uninstall' $0
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jar\shell\MultiHub.Import"
    DeleteRegKey HKCU "Software\Classes\CLSID\{D13545AA-7932-40EA-A839-5674FE732419}"
    DeleteRegValue HKCU "Software\MultiHub" "ExplorerImport"
    DeleteRegKey /ifempty HKCU "Software\MultiHub"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
!include nsDialogs.nsh
!include FileFunc.nsh

Var MultiHubBase
Var MultiHubMakeFolder
Var MultiHubDirectoryInput
Var MultiHubFolderCheckbox
Var MultiHubPreview
Var MultiHubDestination

!macro customPageAfterChangeDir
  Page custom MultiHubDirectoryPage MultiHubDirectoryLeave

Function MultiHubReadDirectory
  ${NSD_GetText} $MultiHubDirectoryInput $MultiHubBase
  ${NSD_GetState} $MultiHubFolderCheckbox $MultiHubMakeFolder
  Call MultiHubResolveDirectory
FunctionEnd

Function MultiHubResolveDirectory
  StrCpy $MultiHubDestination ""
  StrCpy $0 $MultiHubBase 2 1
  StrCpy $1 $MultiHubBase 2
  StrCpy $2 $MultiHubBase 4
  ${If} $2 == "\\?\"
  ${OrIf} $2 == "\\.\"
    Return
  ${EndIf}
  ${If} $0 != ":\"
  ${AndIf} $1 != "\\"
    Return
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$MultiHubBase", i ${NSIS_MAX_STRLEN}, w .r2, p 0) i .r3'
  ${If} $3 == 0
  ${OrIf} $3 >= ${NSIS_MAX_STRLEN}
    Return
  ${EndIf}
  StrCpy $MultiHubDestination $2
  ${GetRoot} "$MultiHubDestination" $0
  StrCpy $1 "$MultiHubDestination" 1 -1
  ${If} $1 == "\"
  ${AndIf} "$0\" != "$MultiHubDestination"
    StrCpy $MultiHubDestination "$MultiHubDestination" -1
  ${EndIf}
  ${If} $MultiHubMakeFolder == ${BST_CHECKED}
    ${GetFileName} "$MultiHubDestination" $0
    ${If} $0 != "${PRODUCT_NAME}"
    ${AndIfNot} ${FileExists} "$MultiHubDestination\${UNINSTALL_FILENAME}"
      StrCpy $1 "$MultiHubDestination" 1 -1
      ${If} $1 == "\"
        StrCpy $MultiHubDestination "$MultiHubDestination${PRODUCT_NAME}"
      ${Else}
        StrCpy $MultiHubDestination "$MultiHubDestination\${PRODUCT_NAME}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function MultiHubDirectoryChanged
  Pop $0
  Call MultiHubReadDirectory
  ${NSD_SetText} $MultiHubPreview "$MultiHubDestination"
FunctionEnd

Function MultiHubBrowse
  Pop $0
  ${NSD_GetText} $MultiHubDirectoryInput $MultiHubBase
  nsDialogs::SelectFolderDialog "Выберите папку" "$MultiHubBase"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $MultiHubDirectoryInput "$0"
  ${EndIf}
FunctionEnd

Function MultiHubDirectoryPage
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  ${If} $MultiHubBase == ""
    StrCpy $MultiHubBase $INSTDIR
    StrCpy $MultiHubMakeFolder ${BST_CHECKED}
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Папка установки" "Выберите, куда установить ${PRODUCT_NAME}."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 14u "Выбранный путь"
  Pop $0
  ${NSD_CreateDirRequest} 0 17u 77% 13u "$MultiHubBase"
  Pop $MultiHubDirectoryInput
  ${NSD_OnChange} $MultiHubDirectoryInput MultiHubDirectoryChanged
  ${NSD_CreateBrowseButton} 79% 16u 21% 15u "Обзор…"
  Pop $0
  ${NSD_OnClick} $0 MultiHubBrowse
  ${NSD_CreateCheckbox} 0 40u 100% 15u "Создать папку ${PRODUCT_NAME} в выбранном месте"
  Pop $MultiHubFolderCheckbox
  ${NSD_SetState} $MultiHubFolderCheckbox $MultiHubMakeFolder
  ${NSD_OnClick} $MultiHubFolderCheckbox MultiHubDirectoryChanged
  ${NSD_CreateLabel} 0 65u 100% 13u "Итоговая папка установки"
  Pop $0
  Call MultiHubReadDirectory
  ${NSD_CreateLabel} 0 81u 100% 30u "$MultiHubDestination"
  Pop $MultiHubPreview
  nsDialogs::Show
FunctionEnd

Function MultiHubDirectoryLeave
  Call MultiHubReadDirectory
  ${GetRoot} "$MultiHubDestination" $0
  ${If} $MultiHubDestination == ""
  ${OrIf} $0 == "$MultiHubDestination"
  ${OrIf} "$0\" == "$MultiHubDestination"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Выберите папку внутри диска или включите создание папки ${PRODUCT_NAME}."
    Abort
  ${EndIf}
  ${If} ${FileExists} "$MultiHubDestination\*.*"
    ${IfNot} ${FileExists} "$MultiHubDestination\${UNINSTALL_FILENAME}"
    ${OrIfNot} ${FileExists} "$MultiHubDestination\${APP_EXECUTABLE_FILENAME}"
      FindFirst $0 $1 "$MultiHubDestination\*.*"
      ${DoWhile} $1 != ""
        ${If} $1 != "."
        ${AndIf} $1 != ".."
          FindClose $0
          MessageBox MB_OK|MB_ICONEXCLAMATION "Выберите пустую папку или включите создание отдельной папки ${PRODUCT_NAME}."
          Abort
        ${EndIf}
        FindNext $0 $1
      ${Loop}
      FindClose $0
    ${EndIf}
  ${EndIf}
  StrCpy $INSTDIR "$MultiHubDestination"
FunctionEnd
!macroend
!endif
