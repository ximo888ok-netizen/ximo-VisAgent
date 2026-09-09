$ErrorActionPreference = 'Stop'
[byte[]]$bytes = [Convert]::FromBase64String($args[0])
$width = [int]$args[1]
$height = [int]$args[2]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTask = $asTask.MakeGenericMethod([System.WindowsRuntimeSystemExtensions].Assembly.GetType('System.Runtime.InteropServices.WindowsRuntime.IAsyncOperation`1').MakeGenericType([Windows.Storage.Streams.DataReader]))
function Await($op) {
  $task = $asTask.Invoke($null, @($op))
  $task.Wait(10000) | Out-Null
  $task.Result
}
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream([System.IO.MemoryStream]::new($bytes))
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
$bmp = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied))
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }
if (-not $engine) { Write-Output '[]'; exit }
$result = Await ($engine.RecognizeAsync($bmp))
$lines = @()
$scaleX = $width / $bmp.PixelWidth
$scaleY = $height / $bmp.PixelHeight
foreach ($line in $result.Lines) {
  $x = [int]($line.Words[0].BoundingRect.X * $scaleX)
  $y = [int]($line.Words[0].BoundingRect.Y * $scaleY)
  $rx = [int]($line.Words[0].BoundingRect.X * $scaleX)
  $ry = [int]($line.Words[0].BoundingRect.Y * $scaleY)
  $rw = 0; $rh = 0
  foreach ($w in $line.Words) {
    $wx = [int]($w.BoundingRect.X * $scaleX)
    $wy = [int]($w.BoundingRect.Y * $scaleY)
    $ww = [int]($w.BoundingRect.Width * $scaleX)
    $wh = [int]($w.BoundingRect.Height * $scaleY)
    if ($rw -eq 0) { $rx = $wx; $ry = $wy; $rw = $wx + $ww; $rh = $wy + $wh }
    else {
      if ($wx -lt $rx) { $rx = $wx }
      if ($wy -lt $ry) { $ry = $wy }
      if ($wx + $ww -gt $rw) { $rw = $wx + $ww }
      if ($wy + $wh -gt $rh) { $rh = $wy + $wh }
    }
  }
  $w = $rw - $rx; $h = $rh - $ry
  $lines += @{ text = $line.Text.Trim(); x = $rx; y = $ry; w = $w; h = $h }
}
$out = $lines | ForEach-Object { '{"text":"' + ($_.text -replace '["\r\n]', ' ') + '","x":' + $_.x + ',"y":' + $_.y + ',"w":' + $_.w + ',"h":' + $_.h + '}' }
Write-Output ('[' + ($out -join ',') + ']')
