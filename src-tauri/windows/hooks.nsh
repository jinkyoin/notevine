; Lists Notevine under "Open with" for .md files (FR-VLT-10). Only OpenWithProgids is
; written, so whichever program opens .md by default stays the default. bundle
; fileAssociations isn't used because it replaces that default.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Notevine.md" "" "Markdown document"
  WriteRegStr SHCTX "Software\Classes\Notevine.md\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Notevine.md\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "Notevine.md" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Notevine.md"
  DeleteRegKey SHCTX "Software\Classes\Notevine.md"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
