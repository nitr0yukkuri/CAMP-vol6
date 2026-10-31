$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing.Common

$sourceDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public\fish-mascots'))
$destinationDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public\fish-mascots-transparent'))
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.png' -File | Sort-Object Name)

if ($sourceFiles.Count -eq 0) {
    throw "No source mascot PNGs found at $sourceDirectory"
}

New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
foreach ($sourceFile in $sourceFiles) {
    $source = [Drawing.Bitmap]::new($sourceFile.FullName)
    $width = $source.Width
    $height = $source.Height
    $pixels = [int[]]::new($width * $height)
    $colorCounts = @{}
    $dominantColor = 0
    $dominantCount = 0

    for ($y = 0; $y -lt $height; $y++) {
        for ($x = 0; $x -lt $width; $x++) {
            $color = $source.GetPixel($x, $y)
            $rgb = ([int]$color.R -shl 16) -bor ([int]$color.G -shl 8) -bor [int]$color.B
            $index = $y * $width + $x
            $pixels[$index] = $rgb
            $count = 1
            if ($colorCounts.ContainsKey($rgb)) {
                $count = [int]$colorCounts[$rgb] + 1
            }
            $colorCounts[$rgb] = $count
            if ($count -gt $dominantCount) {
                $dominantColor = $rgb
                $dominantCount = $count
            }
        }
    }

    $bgR = ($dominantColor -shr 16) -band 255
    $bgG = ($dominantColor -shr 8) -band 255
    $bgB = $dominantColor -band 255
    $outside = [bool[]]::new($pixels.Length)
    $queue = [Collections.Queue]::new()

    for ($x = 0; $x -lt $width; $x++) {
        foreach ($y in @(0, ($height - 1))) {
            $index = $y * $width + $x
            $rgb = $pixels[$index]
            $r = ($rgb -shr 16) -band 255
            $g = ($rgb -shr 8) -band 255
            $b = $rgb -band 255
            if ([Math]::Min($r, [Math]::Min($g, $b)) -ge 178 -and [Math]::Abs($r - $bgR) -le 56 -and [Math]::Abs($g - $bgG) -le 56 -and [Math]::Abs($b - $bgB) -le 56 -and -not $outside[$index]) {
                $outside[$index] = $true
                $queue.Enqueue($index)
            }
        }
    }
    for ($y = 1; $y -lt $height - 1; $y++) {
        foreach ($x in @(0, ($width - 1))) {
            $index = $y * $width + $x
            $rgb = $pixels[$index]
            $r = ($rgb -shr 16) -band 255
            $g = ($rgb -shr 8) -band 255
            $b = $rgb -band 255
            if ([Math]::Min($r, [Math]::Min($g, $b)) -ge 178 -and [Math]::Abs($r - $bgR) -le 56 -and [Math]::Abs($g - $bgG) -le 56 -and [Math]::Abs($b - $bgB) -le 56 -and -not $outside[$index]) {
                $outside[$index] = $true
                $queue.Enqueue($index)
            }
        }
    }

    $dx = @(-1, 0, 1, -1, 1, -1, 0, 1)
    $dy = @(-1, -1, -1, 0, 0, 1, 1, 1)
    while ($queue.Count -gt 0) {
        $index = [int]$queue.Dequeue()
        $x = $index % $width
        $y = [Math]::Floor($index / $width)
        for ($i = 0; $i -lt 8; $i++) {
            $nextX = $x + $dx[$i]
            $nextY = $y + $dy[$i]
            if ($nextX -lt 0 -or $nextX -ge $width -or $nextY -lt 0 -or $nextY -ge $height) { continue }

            $nextIndex = $nextY * $width + $nextX
            if ($outside[$nextIndex]) { continue }
            $rgb = $pixels[$nextIndex]
            $r = ($rgb -shr 16) -band 255
            $g = ($rgb -shr 8) -band 255
            $b = $rgb -band 255
            if ([Math]::Min($r, [Math]::Min($g, $b)) -lt 178 -or [Math]::Abs($r - $bgR) -gt 56 -or [Math]::Abs($g - $bgG) -gt 56 -or [Math]::Abs($b - $bgB) -gt 56) { continue }

            $outside[$nextIndex] = $true
            $queue.Enqueue($nextIndex)
        }
    }

    $output = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $removedPixels = 0
    try {
        for ($y = 0; $y -lt $height; $y++) {
            for ($x = 0; $x -lt $width; $x++) {
                $index = $y * $width + $x
                $rgb = $pixels[$index]
                $r = ($rgb -shr 16) -band 255
                $g = ($rgb -shr 8) -band 255
                $b = $rgb -band 255
                if (-not $outside[$index]) {
                    $output.SetPixel($x, $y, [Drawing.Color]::FromArgb(255, $r, $g, $b))
                    continue
                }

                $alpha = 1.0 - [Math]::Min($r / [double]$bgR, [Math]::Min($g / [double]$bgG, $b / [double]$bgB))
                $alpha = [Math]::Max(0.0, [Math]::Min(1.0, $alpha))
                if ($alpha -le 0.04) {
                    $output.SetPixel($x, $y, [Drawing.Color]::FromArgb(0, 0, 0, 0))
                    $removedPixels++
                    continue
                }

                $outR = [int][Math]::Round(($r - ((1.0 - $alpha) * $bgR)) / $alpha)
                $outG = [int][Math]::Round(($g - ((1.0 - $alpha) * $bgG)) / $alpha)
                $outB = [int][Math]::Round(($b - ((1.0 - $alpha) * $bgB)) / $alpha)
                $outR = [Math]::Max(0, [Math]::Min(255, $outR))
                $outG = [Math]::Max(0, [Math]::Min(255, $outG))
                $outB = [Math]::Max(0, [Math]::Min(255, $outB))
                $output.SetPixel($x, $y, [Drawing.Color]::FromArgb([int][Math]::Round($alpha * 255), $outR, $outG, $outB))
            }
        }

        $destinationPath = Join-Path $destinationDirectory $sourceFile.Name
        $output.Save($destinationPath, [Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $output.Dispose()
        $source.Dispose()
    }

    Write-Output ("{0}: background pixels cleared: {1}" -f $sourceFile.Name, $removedPixels)
}
