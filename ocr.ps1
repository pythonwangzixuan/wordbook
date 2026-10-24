param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Width = 1800,
  [int]$MaxPages = 40
)

# OCR a scanned PDF with the built-in Windows PDF renderer and OCR engine.
# Emits one NDJSON line per page: {"page":1,"text":"..."}
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
function AwaitAction($WinRtAction) {
    $netTask = $asTaskAction.Invoke($null, @($WinRtAction))
    $netTask.Wait(-1) | Out-Null
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null

function Test-Cjk([char]$ch) {
    $code = [int]$ch
    return (($code -ge 0x4E00 -and $code -le 0x9FFF) -or
            ($code -ge 0x3400 -and $code -le 0x4DBF) -or
            ($code -ge 0x3000 -and $code -le 0x303F) -or
            ($code -ge 0xFF00 -and $code -le 0xFFEF))
}

function Join-Words($words) {
    $sb = New-Object System.Text.StringBuilder
    $prev = $null
    foreach ($w in $words) {
        $t = $w.Text
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        if ($null -ne $prev) {
            $gap = $w.BoundingRect.X - ($prev.BoundingRect.X + $prev.BoundingRect.Width)
            $h = [Math]::Max($prev.BoundingRect.Height, $w.BoundingRect.Height)
            if ($h -gt 0 -and $gap -gt $h * 2.0) {
                # Large horizontal gap between words = a blank slot in the original sheet
                [void]$sb.Append([char]0x3000).Append([char]0x3000)
            }
            elseif (-not (Test-Cjk $prev.Text[$prev.Text.Length - 1]) -and -not (Test-Cjk $t[0])) {
                [void]$sb.Append(' ')
            }
        }
        [void]$sb.Append($t)
        $prev = $w
    }
    return $sb.ToString()
}

function Get-PageLines($ocrResult) {
    # Rebuild visual lines from word rectangles (the built-in order can split
    # a line at blank slots, which scrambles reading order).
    $words = @()
    foreach ($line in $ocrResult.Lines) {
        foreach ($w in $line.Words) { $words += $w }
    }
    if (-not $words.Count) { return @() }
    $sorted = $words | Sort-Object { $_.BoundingRect.Y }

    $rows = @()
    $cur = $null
    foreach ($w in $sorted) {
        $r = $w.BoundingRect
        if ($null -eq $cur -or [Math]::Abs($r.Y - $cur.y) -gt [Math]::Max($cur.h, $r.Height) * 1.2) {
            if ($null -ne $cur) { $rows += $cur }
            $cur = @{ y = $r.Y; h = $r.Height; words = @($w) }
        }
        else {
            $cur.h = [Math]::Max($cur.h, $r.Height)
            $cur.words += $w
        }
    }
    if ($null -ne $cur) { $rows += $cur }

    $out = @()
    foreach ($row in $rows) {
        $line = ($row.words | Sort-Object { $_.BoundingRect.X })
        $text = Join-Words $line
        if (-not [string]::IsNullOrWhiteSpace($text)) { $out += $text }
    }
    return $out
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { throw "No OCR language pack available on this system" }

$total = [Math]::Min($doc.PageCount, $MaxPages)
for ($i = 1; $i -le $total; $i++) {
    $page = $doc.GetPage($i - 1)
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $opts = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
    $opts.DestinationWidth = [uint32]$Width
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    $stream.Seek(0)

    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = Get-PageLines $result

    $obj = @{ page = $i; text = ($lines -join "`n") } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($obj)

    $bitmap.Dispose()
    $stream.Dispose()
    $page.Dispose()
}
[Console]::Out.WriteLine((@{ done = $true; pages = $total } | ConvertTo-Json -Compress))
