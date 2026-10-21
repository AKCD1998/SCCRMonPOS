param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../installer/Assets'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$posBlue = [Drawing.Color]::FromArgb(11,31,184)
$posYellow = [Drawing.Color]::FromArgb(246,233,107)
function New-PosBadge([int]$Size) {
    $posImage = [Drawing.Bitmap]::new($Size,$Size)
    $posGraphics = [Drawing.Graphics]::FromImage($posImage)
    $posPath = [Drawing.Drawing2D.GraphicsPath]::new()
    $posBrush = [Drawing.SolidBrush]::new($posBlue)
    $posAccent = [Drawing.SolidBrush]::new($posYellow)
    $posFont = [Drawing.Font]::new('Segoe UI',($Size * .46),[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
    $posFormat = [Drawing.StringFormat]::new()
    try {
        $posGraphics.Clear([Drawing.Color]::Transparent)
        $posGraphics.SmoothingMode = 'AntiAlias'
        $posGraphics.TextRenderingHint = 'AntiAliasGridFit'
        $posRadius = [single]($Size * .20); $posMargin = [single]($Size * .025)
        $posWidth = [single]($Size - 2*$posMargin)
        $posPath.AddArc($posMargin,$posMargin,$posRadius,$posRadius,180,90)
        $posPath.AddArc($Size-$posMargin-$posRadius,$posMargin,$posRadius,$posRadius,270,90)
        $posPath.AddArc($Size-$posMargin-$posRadius,$Size-$posMargin-$posRadius,$posRadius,$posRadius,0,90)
        $posPath.AddArc($posMargin,$Size-$posMargin-$posRadius,$posRadius,$posRadius,90,90)
        $posPath.CloseFigure()
        $posGraphics.FillPath($posBrush,$posPath)
        $posGraphics.SetClip($posPath)
        $posGraphics.FillRectangle($posAccent,[single]0,[single]($Size*.84),[single]$Size,[single]($Size*.16))
        $posFormat.Alignment='Center'; $posFormat.LineAlignment='Center'
        $posGraphics.DrawString('SC',$posFont,[Drawing.Brushes]::White,[Drawing.RectangleF]::new(0,0,$Size,($Size*.86)),$posFormat)
    } finally { $posGraphics.Dispose(); $posPath.Dispose(); $posBrush.Dispose(); $posAccent.Dispose(); $posFont.Dispose(); $posFormat.Dispose() }
    return $posImage
}
$posBadge = New-PosBadge 256
try { $posBadge.Save((Join-Path $OutputDirectory 'wizard-logo.png'),[Drawing.Imaging.ImageFormat]::Png) } finally { $posBadge.Dispose() }

$posSide = [Drawing.Bitmap]::new(656,1256)
$posGraphics = [Drawing.Graphics]::FromImage($posSide)
$posGradient = [Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.Rectangle]::new(0,0,656,1256),$posBlue,[Drawing.Color]::FromArgb(7,15,72),[single]90)
$posYellowBrush = [Drawing.SolidBrush]::new($posYellow)
$posFonts = @(
    [Drawing.Font]::new('Segoe UI',70,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel),
    [Drawing.Font]::new('Segoe UI',27,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel),
    [Drawing.Font]::new('Segoe UI',40,[Drawing.FontStyle]::Regular,[Drawing.GraphicsUnit]::Pixel),
    [Drawing.Font]::new('Segoe UI',23,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
)
try {
    $posGraphics.SmoothingMode='AntiAlias'; $posGraphics.TextRenderingHint='AntiAliasGridFit'
    $posGraphics.FillRectangle($posGradient,0,0,656,1256)
    $posBadge = New-PosBadge 232
    try { $posGraphics.DrawImage($posBadge,52,64,232,232) } finally { $posBadge.Dispose() }
    $posGraphics.DrawString('SCCRM',$posFonts[0],[Drawing.Brushes]::White,50,370)
    $posGraphics.DrawString('POS COMPANION',$posFonts[1],$posYellowBrush,56,468)
    $posGraphics.FillRectangle($posYellowBrush,56,540,72,6)
    $posGraphics.DrawString("Membership`nmade simple.",$posFonts[2],[Drawing.Brushes]::White,52,600)
    $posGraphics.FillPolygon($posYellowBrush,[Drawing.Point[]]@([Drawing.Point]::new(430,1256),[Drawing.Point]::new(656,1020),[Drawing.Point]::new(656,1256)))
    $posGraphics.DrawString('SC DRUGSTORE',$posFonts[3],$posYellowBrush,56,1130)
    $posSide.Save((Join-Path $OutputDirectory 'wizard-side.png'),[Drawing.Imaging.ImageFormat]::Png)
} finally { $posGraphics.Dispose(); $posSide.Dispose(); $posGradient.Dispose(); $posYellowBrush.Dispose(); foreach($posFont in $posFonts){$posFont.Dispose()} }

$posSizes = @(16,32,48,64,256)
$posImages = @()
foreach($posSize in $posSizes) {
    $posBadge = New-PosBadge $posSize; $posMemory = [IO.MemoryStream]::new()
    try { $posBadge.Save($posMemory,[Drawing.Imaging.ImageFormat]::Png); $posImages += ,($posMemory.ToArray()) } finally { $posBadge.Dispose(); $posMemory.Dispose() }
}
$posIconFile = [IO.File]::Create((Join-Path $OutputDirectory 'sc.ico'))
$posWriter = [IO.BinaryWriter]::new($posIconFile)
try {
    $posWriter.Write([uint16]0); $posWriter.Write([uint16]1); $posWriter.Write([uint16]$posSizes.Count)
    $posOffset = 6 + 16 * $posSizes.Count
    for($posIndex=0;$posIndex -lt $posSizes.Count;$posIndex++) {
        $posByteSize = if($posSizes[$posIndex] -eq 256){0}else{$posSizes[$posIndex]}
        $posWriter.Write([byte]$posByteSize); $posWriter.Write([byte]$posByteSize); $posWriter.Write([byte]0); $posWriter.Write([byte]0)
        $posWriter.Write([uint16]1); $posWriter.Write([uint16]32); $posWriter.Write([uint32]$posImages[$posIndex].Length); $posWriter.Write([uint32]$posOffset)
        $posOffset += $posImages[$posIndex].Length
    }
    foreach($posBytes in $posImages) { $posWriter.Write([byte[]]$posBytes) }
} finally { $posWriter.Dispose(); $posIconFile.Dispose() }
Write-Output 'Generated SC blue/yellow installer branding.'
