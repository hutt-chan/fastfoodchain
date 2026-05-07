$ErrorActionPreference = 'Stop'
function Export-DocxText {
  param([string]$SourcePath, [string]$OutPath)
  if (-not (Test-Path $SourcePath)) {
    Write-Host "MISSING: $SourcePath"
    return
  }
  $tmp = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Copy-Item $SourcePath (Join-Path $tmp 'doc.zip')
    Expand-Archive -Path (Join-Path $tmp 'doc.zip') -DestinationPath (Join-Path $tmp 'unzipped') -Force
    $xmlPath = Join-Path $tmp 'unzipped\word\document.xml'
    $xml = [xml](Get-Content $xmlPath -Raw -Encoding UTF8)
    $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
    $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
    $sb = New-Object System.Text.StringBuilder
    foreach ($n in $xml.SelectNodes('//w:t', $ns)) {
      [void]$sb.Append($n.InnerText)
    }
    $sb.ToString() | Out-File -FilePath $OutPath -Encoding utf8
    Write-Host "Wrote $OutPath"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
Export-DocxText 'e:\DacTaUseCase_FastFoodChain.docx' 'c:\Users\Lenovo\Desktop\FastFoodChain\docs_usecase.txt'
Export-DocxText 'e:\SequenceDiagram_FastFoodChain.docx' 'c:\Users\Lenovo\Desktop\FastFoodChain\docs_sequence.txt'
