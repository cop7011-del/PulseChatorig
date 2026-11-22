Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = dir

' Start server hidden
WshShell.Run "cmd /c node server/index.js", 0, False
WScript.Sleep 2000

edge1 = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
edge2 = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
chrome1 = "C:\Program Files\Google\Chrome\Application\chrome.exe"
chrome2 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
appUrl = "http://localhost:4000/pulse.html"
profileDir = dir & "\data\edge-profile"

If fso.FileExists(edge1) Then
  WshShell.Run """" & edge1 & """ --app=" & appUrl & " --user-data-dir=""" & profileDir & """", 1, False
ElseIf fso.FileExists(edge2) Then
  WshShell.Run """" & edge2 & """ --app=" & appUrl & " --user-data-dir=""" & profileDir & """", 1, False
ElseIf fso.FileExists(chrome1) Then
  WshShell.Run """" & chrome1 & """ --app=" & appUrl & " --user-data-dir=""" & profileDir & """", 1, False
ElseIf fso.FileExists(chrome2) Then
  WshShell.Run """" & chrome2 & """ --app=" & appUrl & " --user-data-dir=""" & profileDir & """", 1, False
Else
  WshShell.Run appUrl, 1, False
End If
