# Generates the Claude Conversation Exporter icons (no external assets needed).
# The mark is a chat bubble containing a download arrow: conversation export,
# without imagery that could imply cookie or credential theft.
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}

function New-RoundedRectanglePath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

# Draw once at high resolution, then downsample to each required Chrome size.
$masterSize = 1024
$master = New-Object System.Drawing.Bitmap($masterSize, $masterSize)
$g = [System.Drawing.Graphics]::FromImage($master)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded charcoal tile.
$tilePath = New-RoundedRectanglePath 36 36 952 952 220
$top = [System.Drawing.Color]::FromArgb(255, 39, 34, 30)
$bottom = [System.Drawing.Color]::FromArgb(255, 18, 16, 14)
$tileBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 0)),
    (New-Object System.Drawing.PointF(0, 1024)),
    $top,
    $bottom
)
$g.FillPath($tileBrush, $tilePath)

# Coral conversation bubble with a small tail.
$bubblePath = New-RoundedRectanglePath 158 142 708 548 118
$bubbleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 217, 119, 87))
$g.FillPath($bubbleBrush, $bubblePath)
$tail = @(
    (New-Object System.Drawing.PointF(252, 650)),
    (New-Object System.Drawing.PointF(252, 790)),
    (New-Object System.Drawing.PointF(438, 650))
)
$g.FillPolygon($bubbleBrush, [System.Drawing.PointF[]]$tail)

# Cream download arrow inside the bubble.
$arrowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 246, 240, 232))
$stem = New-RoundedRectanglePath 458 250 108 222 50
$g.FillPath($arrowBrush, $stem)
$arrowHead = @(
    (New-Object System.Drawing.PointF(354, 430)),
    (New-Object System.Drawing.PointF(670, 430)),
    (New-Object System.Drawing.PointF(512, 596))
)
$g.FillPolygon($arrowBrush, [System.Drawing.PointF[]]$arrowHead)

$sizes = @(16, 32, 48, 128)
foreach ($s in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($s, $s)
    $resize = [System.Drawing.Graphics]::FromImage($bitmap)
    $resize.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $resize.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resize.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $resize.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $resize.Clear([System.Drawing.Color]::Transparent)
    $resize.DrawImage($master, 0, 0, $s, $s)

    $path = Join-Path $outDir ("icon{0}.png" -f $s)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $resize.Dispose()
    $bitmap.Dispose()
    Write-Host "wrote $path"
}

$stem.Dispose()
$arrowBrush.Dispose()
$bubblePath.Dispose()
$bubbleBrush.Dispose()
$tilePath.Dispose()
$tileBrush.Dispose()
$g.Dispose()
$master.Dispose()

