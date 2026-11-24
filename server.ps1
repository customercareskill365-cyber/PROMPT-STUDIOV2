param(
    [int]$Port = 7870,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Xml

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StaticDir = Join-Path $Root "static"
$DataDir = Join-Path $Root "data"
$SamplesDir = Join-Path $Root "samples"
$LibraryPath = Join-Path $DataDir "library.json"

if (-not (Test-Path $StaticDir)) { New-Item -ItemType Directory -Path $StaticDir -Force | Out-Null }
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
if (-not (Test-Path $SamplesDir)) { New-Item -ItemType Directory -Path $SamplesDir -Force | Out-Null }

$MimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".txt"  = "text/plain; charset=utf-8"
    ".csv"  = "text/csv; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".ico"  = "image/x-icon"
    ".xlsx" = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ".docx" = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

function ConvertFrom-ExcelColumnLetters {
    param([string]$Letters)
    $col = 0
    foreach ($ch in $Letters.ToUpperInvariant().ToCharArray()) {
        if ($ch -ge 'A' -and $ch -le 'Z') {
            $col = ($col * 26) + ([int][char]$ch - [int][char]'A' + 1)
        }
    }
    return [Math]::Max(0, $col - 1)
}

function ConvertTo-ExcelColumnLetters {
    param([int]$Index)
    $n = $Index + 1
    $str = ""
    while ($n -gt 0) {
        $rem = ($n - 1) % 26
        $str = [char]([int][char]'A' + $rem) + $str
        $n = [Math]::Floor(($n - 1) / 26)
    }
    return $str
}

function Read-ZipEntryText {
    param(
        [System.IO.Compression.ZipArchive]$Zip,
        [string]$EntryPath
    )
    $normalized = $EntryPath.TrimStart("/").Replace("\", "/")
    $entry = $Zip.Entries | Where-Object { $_.FullName.Replace("\", "/").ToLowerInvariant() -eq $normalized.ToLowerInvariant() } | Select-Object -First 1
    if ($null -eq $entry) { return $null }
    $stream = $entry.Open()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Parse-XlsxFile {
    param([string]$FilePath)

    $zip = [System.IO.Compression.ZipFile]::OpenRead($FilePath)
    try {
        $sharedStrings = New-Object System.Collections.Generic.List[string]
        $sstXmlText = Read-ZipEntryText -Zip $zip -EntryPath "xl/sharedStrings.xml"
        if ($null -ne $sstXmlText) {
            [xml]$sstXml = $sstXmlText
            $ns = New-Object System.Xml.XmlNamespaceManager($sstXml.NameTable)
            $ns.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
            $siNodes = $sstXml.SelectNodes("//x:si", $ns)
            if ($siNodes.Count -eq 0) {
                $siNodes = $sstXml.SelectNodes("//*[local-name()='si']")
            }
            foreach ($si in $siNodes) {
                $tNodes = $si.SelectNodes(".//*[local-name()='t']")
                $sb = New-Object System.Text.StringBuilder
                foreach ($t in $tNodes) {
                    [void]$sb.Append($t.InnerText)
                }
                $sharedStrings.Add($sb.ToString())
            }
        }

        # Find first worksheet or all worksheets sorted by sheet name/index
        $sheetEntries = $zip.Entries | Where-Object {
            $p = $_.FullName.Replace("\", "/").ToLowerInvariant()
            $p -like "xl/worksheets/sheet*.xml"
        } | Sort-Object {
            $m = [regex]::Match($_.Name, '(\d+)')
            if ($m.Success) { [int]$m.Groups[1].Value } else { 999 }
        }

        $sheets = New-Object System.Collections.ArrayList
        foreach ($sheetEntry in $sheetEntries) {
            $sheetXmlText = Read-ZipEntryText -Zip $zip -EntryPath $sheetEntry.FullName
            if ($null -eq $sheetXmlText) { continue }
            [xml]$sheetXml = $sheetXmlText
            $rowNodes = $sheetXml.SelectNodes("//*[local-name()='sheetData']/*[local-name()='row']")
            $rows = New-Object System.Collections.ArrayList
            foreach ($rowNode in $rowNodes) {
                $cellMap = @{}
                $maxCol = -1
                $fallbackCol = 0
                $cellNodes = $rowNode.SelectNodes("./*[local-name()='c']")
                foreach ($c in $cellNodes) {
                    $refAttr = $c.GetAttribute("r")
                    $colIdx = $fallbackCol
                    if (-not [string]::IsNullOrEmpty($refAttr)) {
                        $m = [regex]::Match($refAttr, '^([A-Za-z]+)')
                        if ($m.Success) {
                            $colIdx = ConvertFrom-ExcelColumnLetters -Letters $m.Groups[1].Value
                        }
                    }
                    $fallbackCol = $colIdx + 1
                    if ($colIdx -gt $maxCol) { $maxCol = $colIdx }

                    $cellType = $c.GetAttribute("t")
                    $val = ""
                    if ($cellType -eq "s") {
                        $vNode = $c.SelectSingleNode("./*[local-name()='v']")
                        if ($null -ne $vNode -and $vNode.InnerText -match '^\d+$') {
                            $idx = [int]$vNode.InnerText
                            if ($idx -ge 0 -and $idx -lt $sharedStrings.Count) {
                                $val = $sharedStrings[$idx]
                            }
                        }
                    } elseif ($cellType -eq "inlineStr") {
                        $tNodes = $c.SelectNodes(".//*[local-name()='t']")
                        $sb = New-Object System.Text.StringBuilder
                        foreach ($t in $tNodes) { [void]$sb.Append($t.InnerText) }
                        $val = $sb.ToString()
                    } elseif ($cellType -eq "str" -or $cellType -eq "e") {
                        $vNode = $c.SelectSingleNode("./*[local-name()='v']")
                        if ($null -ne $vNode) { $val = $vNode.InnerText }
                    } elseif ($cellType -eq "b") {
                        $vNode = $c.SelectSingleNode("./*[local-name()='v']")
                        if ($null -ne $vNode) {
                            $val = if ($vNode.InnerText -eq "1") { "TRUE" } else { "FALSE" }
                        }
                    } else {
                        $vNode = $c.SelectSingleNode("./*[local-name()='v']")
                        if ($null -ne $vNode) {
                            $val = $vNode.InnerText
                        } else {
                            $isNodes = $c.SelectNodes(".//*[local-name()='t']")
                            if ($isNodes.Count -gt 0) {
                                $sb = New-Object System.Text.StringBuilder
                                foreach ($t in $isNodes) { [void]$sb.Append($t.InnerText) }
                                $val = $sb.ToString()
                            }
                        }
                    }
                    $cellMap[$colIdx] = $val
                }

                if ($maxCol -ge 0) {
                    $rowArr = New-Object string[] ($maxCol + 1)
                    $hasNonEmpty = $false
                    for ($i = 0; $i -le $maxCol; $i++) {
                        if ($cellMap.ContainsKey($i)) {
                            $v = [string]$cellMap[$i]
                            $rowArr[$i] = $v
                            if (-not [string]::IsNullOrWhiteSpace($v)) { $hasNonEmpty = $true }
                        } else {
                            $rowArr[$i] = ""
                        }
                    }
                    if ($hasNonEmpty) {
                        [void]$rows.Add($rowArr)
                    }
                }
            }

            if ($rows.Count -gt 0) {
                [void]$sheets.Add(@{
                    name = $sheetEntry.Name
                    rows = @($rows.ToArray())
                })
            }
        }

        $primaryRows = if ($sheets.Count -gt 0) { $sheets[0].rows } else { @() }
        return @{
            type   = "xlsx"
            rows   = $primaryRows
            sheets = @($sheets.ToArray())
        }
    } finally {
        $zip.Dispose()
    }
}

function Get-DocxParagraphText {
    param($ParagraphNode)
    $sb = New-Object System.Text.StringBuilder
    foreach ($child in $ParagraphNode.ChildNodes) {
        $lname = $child.LocalName
        if ($lname -eq "r") {
            foreach ($rc in $child.ChildNodes) {
                if ($rc.LocalName -eq "t" -or $rc.LocalName -eq "delText") {
                    [void]$sb.Append($rc.InnerText)
                } elseif ($rc.LocalName -eq "br" -or $rc.LocalName -eq "cr") {
                    [void]$sb.Append("`n")
                } elseif ($rc.LocalName -eq "tab") {
                    [void]$sb.Append("`t")
                }
            }
        } elseif ($lname -eq "hyperlink") {
            $tNodes = $child.SelectNodes(".//*[local-name()='t']")
            foreach ($t in $tNodes) { [void]$sb.Append($t.InnerText) }
        }
    }
    return $sb.ToString().Trim()
}

function Parse-DocxFile {
    param([string]$FilePath)

    $zip = [System.IO.Compression.ZipFile]::OpenRead($FilePath)
    try {
        $docXmlText = Read-ZipEntryText -Zip $zip -EntryPath "word/document.xml"
        if ($null -eq $docXmlText) {
            throw "word/document.xml not found inside .docx archive."
        }
        [xml]$docXml = $docXmlText
        $body = $docXml.SelectSingleNode("//*[local-name()='body']")

        $paragraphs = New-Object System.Collections.ArrayList
        $tables = New-Object System.Collections.ArrayList

        if ($null -ne $body) {
            foreach ($node in $body.ChildNodes) {
                if ($node.LocalName -eq "p") {
                    $text = Get-DocxParagraphText -ParagraphNode $node
                    if (-not [string]::IsNullOrWhiteSpace($text)) {
                        $styleNode = $node.SelectSingleNode("./*[local-name()='pPr']/*[local-name()='pStyle']")
                        $styleVal = if ($null -ne $styleNode) {
                            $a = $styleNode.Attributes | Where-Object { $_.LocalName -eq "val" } | Select-Object -First 1
                            if ($null -ne $a) { $a.Value } else { "" }
                        } else { "" }
                        [void]$paragraphs.Add(@{
                            text  = $text
                            style = $styleVal
                        })
                    }
                } elseif ($node.LocalName -eq "tbl") {
                    $tblRows = New-Object System.Collections.ArrayList
                    $trNodes = $node.SelectNodes("./*[local-name()='tr']")
                    foreach ($tr in $trNodes) {
                        $cellValues = New-Object System.Collections.ArrayList
                        $tcNodes = $tr.SelectNodes("./*[local-name()='tc']")
                        $hasContent = $false
                        foreach ($tc in $tcNodes) {
                            $pNodes = $tc.SelectNodes("./*[local-name()='p']")
                            $pTexts = New-Object System.Collections.ArrayList
                            foreach ($p in $pNodes) {
                                $pt = Get-DocxParagraphText -ParagraphNode $p
                                if (-not [string]::IsNullOrWhiteSpace($pt)) {
                                    [void]$pTexts.Add($pt)
                                }
                            }
                            $cellText = ($pTexts -join "`n").Trim()
                            if (-not [string]::IsNullOrWhiteSpace($cellText)) { $hasContent = $true }
                            [void]$cellValues.Add($cellText)
                        }
                        if ($hasContent) {
                            [void]$tblRows.Add(@($cellValues.ToArray()))
                        }
                    }
                    if ($tblRows.Count -gt 0) {
                        [void]$tables.Add(@($tblRows.ToArray()))
                    }
                }
            }
        }

        return @{
            type       = "docx"
            paragraphs = @($paragraphs.ToArray())
            tables     = @($tables.ToArray())
        }
    } finally {
        $zip.Dispose()
    }
}

function Escape-Xml {
    param([string]$Text)
    if ($null -eq $Text) { return "" }
    return [System.Security.SecurityElement]::Escape($Text)
}

function Write-SimpleXlsx {
    param(
        [string]$OutputPath,
        [array]$Rows
    )
    if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }
    $zip = [System.IO.Compression.ZipFile]::Open($OutputPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $addEntry = {
            param([string]$Name, [string]$Content)
            $e = $zip.CreateEntry($Name)
            $s = $e.Open()
            $w = New-Object System.IO.StreamWriter($s, (New-Object System.Text.UTF8Encoding($false)))
            $w.Write($Content)
            $w.Dispose()
            $s.Dispose()
        }

        $contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>
'@
        $rels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
'@
        $wb = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Shot List" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>
'@
        $wbRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
'@

        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
        [void]$sb.Append('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
        for ($rIdx = 0; $rIdx -lt $Rows.Count; $rIdx++) {
            $rNum = $rIdx + 1
            [void]$sb.Append("<row r=`"$rNum`">")
            $row = $Rows[$rIdx]
            for ($cIdx = 0; $cIdx -lt $row.Count; $cIdx++) {
                $colRef = (ConvertTo-ExcelColumnLetters -Index $cIdx) + $rNum
                $val = Escape-Xml ([string]$row[$cIdx])
                [void]$sb.Append("<c r=`"$colRef`" t=`"inlineStr`"><is><t xml:space=`"preserve`">$val</t></is></c>")
            }
            [void]$sb.Append("</row>")
        }
        [void]$sb.Append('</sheetData></worksheet>')

        & $addEntry "[Content_Types].xml" $contentTypes
        & $addEntry "_rels/.rels" $rels
        & $addEntry "xl/workbook.xml" $wb
        & $addEntry "xl/_rels/workbook.xml.rels" $wbRels
        & $addEntry "xl/worksheets/sheet1.xml" $sb.ToString()
    } finally {
        $zip.Dispose()
    }
}

function Write-SimpleDocx {
    param(
        [string]$OutputPath,
        [array]$Paragraphs
    )
    if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }
    $zip = [System.IO.Compression.ZipFile]::Open($OutputPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $addEntry = {
            param([string]$Name, [string]$Content)
            $e = $zip.CreateEntry($Name)
            $s = $e.Open()
            $w = New-Object System.IO.StreamWriter($s, (New-Object System.Text.UTF8Encoding($false)))
            $w.Write($Content)
            $w.Dispose()
            $s.Dispose()
        }

        $contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
'@
        $rels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
'@

        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
        [void]$sb.Append('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>')
        foreach ($p in $Paragraphs) {
            $esc = Escape-Xml ([string]$p)
            [void]$sb.Append("<w:p><w:r><w:t xml:space=`"preserve`">$esc</w:t></w:r></w:p>")
        }
        [void]$sb.Append('<w:sectPr/></w:body></w:document>')

        & $addEntry "[Content_Types].xml" $contentTypes
        & $addEntry "_rels/.rels" $rels
        & $addEntry "word/document.xml" $sb.ToString()
    } finally {
        $zip.Dispose()
    }
}

function Ensure-SampleFiles {
    $xlsxSample = Join-Path $SamplesDir "cyberpunk-documentary-shots.xlsx"
    if (-not (Test-Path $xlsxSample)) {
        $xlsxRows = @(
            @("Video Name", "Neon Rain: The AI Cities of 2099"),
            @("Topic", "Sci-Fi Documentary & Future Architecture"),
            @("AI Model", "Kling 1.6 Pro"),
            @("Target Duration", "6:00"),
            @("Shot #", "Scene Title", "Duration", "Script / Voiceover", "Image Prompt", "Video Prompt", "Notes"),
            @("1", "Orbiting Orbital Ring Dawn", "8s", "In the final decade of the twenty-first century, humanity stopped building outward and began building upward.", "Photorealistic orbital megastructure curving over Earth terminator at golden hour, 8k, anamorphic lens", "Slow majestic orbital camera push-in toward a glowing megastructure ring above blue Earth clouds, golden sunrise glint, cinematic 24fps", "Opening hook - slow push"),
            @("2", "Mega-Tower Rain Canyon", "6s", "Below the cloud deck, vertical districts stretch three kilometers into humid neon fog.", "Cyberpunk skyscraper canyon in heavy rain, holographic signs reflecting in wet asphalt, wide angle 24mm", "Fast vertical drone descent through neon skyscraper canyon in pouring rain, volumetric mist, glowing holographic billboards, smooth gimbal", "Match cut from cloud layer"),
            @("3", "Autonomous Street Market", "8s", "Yet street life persisted beneath the automated transit arteries.", "Bustling futuristic night market under elevated monorail, steam rising from food stalls, warm tungsten vs cyan neon", "Tracking gimbal shot moving through a futuristic night market, steam drifting past glowing umbrellas, overhead maglev passing silently", "Keep motion level 4"),
            @("4", "Bio-Dome Vertical Farm", "6s", "Inside glass atriums, vertical hydro-gardens feed millions without touching natural soil.", "Interior of towering glass bio-dome filled with emerald hydroponic towers and soft diffused sunlight, architectural photography", "Smooth dolly forward along elevated catwalk inside glowing emerald hydroponic atrium, water mist droplets catching sunbeams", "Calm contrast shot"),
            @("5", "Transit Hub Silhouette", "8s", "Every morning, twelve million commuters move through light-speed subterranean hubs.", "Minimalist brutalist futuristic train station, silhouettes of commuters against giant backlit amber glass wall", "Wide static shot as a sleek silver magnetic train glides silently into a misty brutalist transit hall, commuters walking in slow motion", "Subtle crowd motion"),
            @("6", "Solar Mirror Array Desert", "6s", "Far outside the megacities, automated solar deserts power the endless glow.", "Aerial shot of concentric desert solar mirror towers glowing white-hot against twilight sand dunes", "High-altitude aerial orbit around thousands of desert solar mirrors converging golden light beams on a central molten tower", "Warm palette shift"),
            @("7", "Data Vault Cooling Corridor", "8s", "Beneath the desert floor lie the memory banks that keep every city alive.", "Symmetrical corridor of obsidian AI server monoliths with pulsing cyan fiber optics, low fog on floor", "Slow symmetrical Steadicam glide down an obsidian server vault corridor, cyan indicator lights rippling smoothly in reflection", "Hold focus center"),
            @("8", "Rain on Observation Glass", "6s", "For the engineers watching from the upper decks, the city resembles a living circuit.", "Close up of water droplets on floor-to-ceiling window overlooking distant blurred neon skyline, shallow depth of field", "Rack focus from shimmering raindrops on dark window glass to glittering futuristic skyline stretching to the horizon", "Close-up detail"),
            @("9", "Skybridge Storm Break", "10s", "When monsoons roll off the Pacific, lightning illuminates clouds between the bridges.", "Suspended glass skybridge connecting twin towers above storm clouds, dramatic lightning flash inside clouds", "Wide epic shot of suspended skybridge high above swirling storm clouds, distant lightning flashing inside clouds, slow crane lift", "Hero climate shot"),
            @("10", "Rooftop Garden Sunrise", "8s", "Above the concrete storm, quiet rooftop sanctuaries catch the first clean rays of morning.", "Lush rooftop moss and pine garden overlooking misty futuristic city spires at sunrise, soft golden light", "Gentle pan across mist-covered rooftop pine garden as warm sunrise light breaks over distant glass city spires, birds flying past", "Closing tonal shift")
        )
        Write-SimpleXlsx -OutputPath $xlsxSample -Rows $xlsxRows
    }

    $docxSample = Join-Path $SamplesDir "ancient-india-story-shots.docx"
    if (-not (Test-Path $docxSample)) {
        $paras = @(
            "Video Name: Echoes of Hampi - Lost Empire of Stone",
            "Topic: Ancient History & Heritage",
            "Model: Runway Gen-3 Alpha",
            "Target Duration: 7:00",
            "",
            "Shot 1: Sunrise Over Boulder Valley",
            "Duration: 8s",
            "Script: Five hundred years ago, amidst granite boulders older than memory, a metropolis of gold rose beside the Tungabhadra river.",
            "Image Prompt: Epic aerial landscape of Hampi granite boulders and ancient stone temple spires in misty golden sunrise, 8k photorealistic",
            "Video Prompt: Slow sweeping drone flyover above giant weathered granite boulders and ancient Vijayanagara temple towers veiled in golden morning mist",
            "Notes: Start with atmospheric stillness",
            "",
            "Shot 2: River Ferry at Dawn",
            "Duration: 6s",
            "Script: Merchants arrived before first light in round woven coracles gliding across dark water.",
            "Image Prompt: Traditional round coracle boat on calm misty river surrounded by ancient stone ghats at dawn, warm rim light",
            "Video Prompt: Low water-level tracking shot beside a woven coracle boat gliding smoothly across mirror-calm misty river water, gentle ripples",
            "Notes: Subtle water reflection",
            "",
            "Shot 3: The Stone Chariot Courtyard",
            "Duration: 8s",
            "Script: At the heart of the royal sacred center stood monuments carved so finely that stone seemed alive.",
            "Image Prompt: Vittala temple ornate stone chariot in warm afternoon sunlight, intricate carvings, dramatic shadows, architectural 35mm",
            "Video Prompt: Smooth low-angle circular dolly around the carved granite stone chariot, sunlight streaming between carved pillars, dust motes in air",
            "Notes: Keep stone texture crisp",
            "",
            "Shot 4: Musical Pillars Resonance",
            "Duration: 6s",
            "Script: Artisans shaped slender granite columns designed to ring like temple bells.",
            "Image Prompt: Close-up of sculpted granite musical pillars inside dimly lit ancient temple colonnade, shaft of warm sunbeam",
            "Video Prompt: Slow side-tracking close-up past carved granite temple pillars as golden sunbeams sweep across intricate reliefs",
            "Notes: Macro architectural mood",
            "",
            "Shot 5: Royal Bazaar Reconstruction",
            "Duration: 10s",
            "Script: Along avenues nearly a kilometer wide, silk traders from Persia met spice caravans from the coast.",
            "Image Prompt: Bustling 16th century Indian stone colonnade bazaar filled with vibrant silk canopies, spices, lanterns, golden hour",
            "Video Prompt: Steady forward walking POV through a vibrant ancient stone colonnade market lined with saffron silk banners and merchants, warm golden dust",
            "Notes: High detail hero shot",
            "",
            "Shot 6: Stepwell Water Geometry",
            "Duration: 8s",
            "Script: Engineers captured monsoon rain in symmetrical stepped reservoirs that mirrored the sky.",
            "Image Prompt: Symmetrical ancient stepped stone tank filled with emerald water, geometric shadows, bird's eye architectural shot",
            "Video Prompt: Slow overhead crane descent toward a symmetrical stepped stone reservoir as emerald water gently ripples under soft clouds",
            "Notes: Perfect top-down symmetry",
            "",
            "Shot 7: Twilight Lamp Ritual",
            "Duration: 8s",
            "Script: Though empires fall to silence, the stone still remembers the warmth of evening lamps.",
            "Image Prompt: Hundreds of tiny brass oil lamps flickering along ancient carved temple steps at twilight blue hour, cinematic bokeh",
            "Video Prompt: Slow pull-back shot along ancient carved stone steps glowing with warm flickering oil lamps against deep indigo twilight sky",
            "Notes: Closing emotional beat"
        )
        Write-SimpleDocx -OutputPath $docxSample -Paragraphs $paras
    }
}

function Read-LibraryJson {
    if (-not (Test-Path $LibraryPath)) {
        $empty = @{
            version  = 1
            projects = @()
            settings = @{
                autoCompleteOnCopy = $false
                defaultShotSeconds = 6
            }
        }
        $json = ConvertTo-Json -InputObject $empty -Depth 12
        [System.IO.File]::WriteAllText($LibraryPath, $json, [System.Text.Encoding]::UTF8)
        return $json
    }
    return [System.IO.File]::ReadAllText($LibraryPath, [System.Text.Encoding]::UTF8)
}

function Write-LibraryJsonAtomic {
    param([string]$JsonText)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $tmp = "$LibraryPath.tmp"
    $lastErr = $null
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        try {
            if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
            [System.IO.File]::WriteAllText($LibraryPath, $JsonText, $utf8NoBom)
            return
        } catch {
            $lastErr = $_
            Start-Sleep -Milliseconds 40
        }
    }
    throw $lastErr
}

function Read-RequestBody {
    param($Request)
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }
}

function Send-JsonResponse {
    param(
        $Response,
        [int]$StatusCode = 200,
        [string]$JsonText
    )
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonText)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = "application/json; charset=utf-8"
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.Close()
}

function Send-ObjectJson {
    param(
        $Response,
        [int]$StatusCode = 200,
        $Object
    )
    $json = ConvertTo-Json -InputObject $Object -Depth 15
    Send-JsonResponse -Response $Response -StatusCode $StatusCode -JsonText $json
}

Ensure-SampleFiles
[void](Read-LibraryJson)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

Write-Host ""
Write-Host "  Prompt Studio (AI Video Shot Library) is running at http://127.0.0.1:$Port"
Write-Host "  Library saved to: $LibraryPath"
Write-Host "  Sample files in:  $SamplesDir"
Write-Host "  Close this window to stop."
Write-Host ""

if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:$Port"
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response

        $res.AddHeader("Cache-Control", "no-cache")

        $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart("/")
        $method = $req.HttpMethod.ToUpperInvariant()

        if ($rel -eq "api/health" -and $method -eq "GET") {
            Send-ObjectJson -Response $res -Object @{ ok = $true; port = $Port; libraryPath = $LibraryPath }
            continue
        }

        if ($rel -eq "api/library") {
            if ($method -eq "GET") {
                $json = Read-LibraryJson
                Send-JsonResponse -Response $res -JsonText $json
                continue
            } elseif ($method -eq "POST") {
                $body = Read-RequestBody -Request $req
                # Validate JSON before writing
                $parsed = ConvertFrom-Json -InputObject $body
                if ($null -eq $parsed.projects) {
                    Send-ObjectJson -Response $res -StatusCode 400 -Object @{ error = "Invalid library payload: missing projects array." }
                    continue
                }

                $replaceAll = $false
                if ($null -ne $parsed.PSObject.Properties["replaceAll"] -and $parsed.replaceAll -eq $true) {
                    $replaceAll = $true
                }

                if ($replaceAll) {
                    $cleanPayload = @{
                        version  = if ($parsed.version) { $parsed.version } else { 1 }
                        settings = $parsed.settings
                        projects = @($parsed.projects)
                    }
                    $newJson = ConvertTo-Json -InputObject $cleanPayload -Depth 15
                    Write-LibraryJsonAtomic -JsonText $newJson
                    Send-ObjectJson -Response $res -Object @{ ok = $true; count = @($parsed.projects).Count }
                    continue
                }

                # Merge incoming projects with existing disk projects so separate tabs never wipe each other
                $existingRaw = Read-LibraryJson
                $existingLib = ConvertFrom-Json -InputObject $existingRaw
                $mergedMap = @{}
                $orderedIds = New-Object System.Collections.ArrayList

                foreach ($inc in @($parsed.projects)) {
                    if ($null -ne $inc -and -not [string]::IsNullOrWhiteSpace($inc.id)) {
                        $mergedMap[$inc.id] = $inc
                        [void]$orderedIds.Add($inc.id)
                    }
                }
                foreach ($ext in @($existingLib.projects)) {
                    if ($null -ne $ext -and -not [string]::IsNullOrWhiteSpace($ext.id)) {
                        if (-not $mergedMap.ContainsKey($ext.id)) {
                            $mergedMap[$ext.id] = $ext
                            [void]$orderedIds.Add($ext.id)
                        } else {
                            # Keep whichever version has a newer updatedAt timestamp
                            $incProj = $mergedMap[$ext.id]
                            $extTime = if ($ext.updatedAt) { [DateTime]::Parse($ext.updatedAt).ToUniversalTime() } else { [DateTime]::MinValue }
                            $incTime = if ($incProj.updatedAt) { [DateTime]::Parse($incProj.updatedAt).ToUniversalTime() } else { [DateTime]::MinValue }
                            if ($extTime -gt $incTime) {
                                $mergedMap[$ext.id] = $ext
                            }
                        }
                    }
                }

                $mergedProjects = New-Object System.Collections.ArrayList
                foreach ($pid in $orderedIds) {
                    [void]$mergedProjects.Add($mergedMap[$pid])
                }
                $existingLib.projects = @($mergedProjects.ToArray())
                if ($null -ne $parsed.settings) {
                    $existingLib.settings = $parsed.settings
                }
                $mergedJson = ConvertTo-Json -InputObject $existingLib -Depth 15
                Write-LibraryJsonAtomic -JsonText $mergedJson
                Send-ObjectJson -Response $res -Object @{ ok = $true; count = $mergedProjects.Count }
                continue
            }
        }

        if ($rel -eq "api/settings" -and $method -eq "POST") {
            $body = Read-RequestBody -Request $req
            $incomingSettings = ConvertFrom-Json -InputObject $body
            $libRaw = Read-LibraryJson
            $lib = ConvertFrom-Json -InputObject $libRaw
            $lib.settings = $incomingSettings
            $newJson = ConvertTo-Json -InputObject $lib -Depth 15
            Write-LibraryJsonAtomic -JsonText $newJson
            Send-ObjectJson -Response $res -Object @{ ok = $true; settings = $lib.settings }
            continue
        }

        if ($rel -eq "api/project") {
            if ($method -eq "POST") {
                $body = Read-RequestBody -Request $req
                $project = ConvertFrom-Json -InputObject $body
                if ([string]::IsNullOrWhiteSpace($project.id)) {
                    Send-ObjectJson -Response $res -StatusCode 400 -Object @{ error = "Project id is required." }
                    continue
                }
                $libRaw = Read-LibraryJson
                $lib = ConvertFrom-Json -InputObject $libRaw
                $list = New-Object System.Collections.ArrayList
                $replaced = $false
                foreach ($p in @($lib.projects)) {
                    if ($p.id -eq $project.id) {
                        [void]$list.Add($project)
                        $replaced = $true
                    } else {
                        [void]$list.Add($p)
                    }
                }
                if (-not $replaced) {
                    [void]$list.Insert(0, $project)
                }
                $lib.projects = @($list.ToArray())
                $newJson = ConvertTo-Json -InputObject $lib -Depth 15
                Write-LibraryJsonAtomic -JsonText $newJson
                Send-ObjectJson -Response $res -Object @{ ok = $true; project = $project }
                continue
            } elseif ($method -eq "DELETE") {
                $targetId = $req.QueryString["id"]
                if ([string]::IsNullOrWhiteSpace($targetId)) {
                    Send-ObjectJson -Response $res -StatusCode 400 -Object @{ error = "Query parameter 'id' is required." }
                    continue
                }
                $libRaw = Read-LibraryJson
                $lib = ConvertFrom-Json -InputObject $libRaw
                $kept = @($lib.projects | Where-Object { $_.id -ne $targetId })
                $lib.projects = $kept
                $newJson = ConvertTo-Json -InputObject $lib -Depth 15
                Write-LibraryJsonAtomic -JsonText $newJson
                Send-ObjectJson -Response $res -Object @{ ok = $true; remaining = $kept.Count }
                continue
            }
        }

        if ($rel -eq "api/parse-file" -and $method -eq "POST") {
            $body = Read-RequestBody -Request $req
            $payload = ConvertFrom-Json -InputObject $body
            $filename = [string]$payload.filename
            $b64 = [string]$payload.base64
            if ([string]::IsNullOrWhiteSpace($filename) -or [string]::IsNullOrWhiteSpace($b64)) {
                Send-ObjectJson -Response $res -StatusCode 400 -Object @{ error = "Both 'filename' and 'base64' are required." }
                continue
            }
            $ext = [IO.Path]::GetExtension($filename).ToLowerInvariant()
            $tmpFile = Join-Path ([IO.Path]::GetTempPath()) ("promptstudio_" + [Guid]::NewGuid().ToString("N") + $ext)
            try {
                $fileBytes = [Convert]::FromBase64String($b64)
                [IO.File]::WriteAllBytes($tmpFile, $fileBytes)
                if ($ext -eq ".xlsx") {
                    $result = Parse-XlsxFile -FilePath $tmpFile
                    $result["filename"] = $filename
                    Send-ObjectJson -Response $res -Object $result
                } elseif ($ext -eq ".docx") {
                    $result = Parse-DocxFile -FilePath $tmpFile
                    $result["filename"] = $filename
                    Send-ObjectJson -Response $res -Object $result
                } else {
                    $text = [System.Text.Encoding]::UTF8.GetString($fileBytes)
                    Send-ObjectJson -Response $res -Object @{
                        type     = $ext.TrimStart(".")
                        filename = $filename
                        text     = $text
                    }
                }
            } catch {
                Send-ObjectJson -Response $res -StatusCode 500 -Object @{ error = "Failed to parse file: $($_.Exception.Message)" }
            } finally {
                if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
            }
            continue
        }

        if ($rel -eq "api/export-xlsx" -and $method -eq "POST") {
            $body = Read-RequestBody -Request $req
            $payload = ConvertFrom-Json -InputObject $body
            $rows = @($payload.rows)
            $tmpOut = Join-Path ([IO.Path]::GetTempPath()) ("promptstudio_export_" + [Guid]::NewGuid().ToString("N") + ".xlsx")
            try {
                Write-SimpleXlsx -OutputPath $tmpOut -Rows $rows
                $xlsxBytes = [IO.File]::ReadAllBytes($tmpOut)
                $res.StatusCode = 200
                $res.ContentType = $MimeTypes[".xlsx"]
                $res.ContentLength64 = $xlsxBytes.Length
                $res.OutputStream.Write($xlsxBytes, 0, $xlsxBytes.Length)
                $res.Close()
            } finally {
                if (Test-Path $tmpOut) { Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue }
            }
            continue
        }

        if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }

        $target = $null
        if ($rel.StartsWith("samples/")) {
            $sub = $rel.Substring(8).Replace("/", "\")
            $cand = Join-Path $SamplesDir $sub
            if ($cand.StartsWith($SamplesDir) -and (Test-Path $cand -PathType Leaf)) {
                $target = $cand
            }
        } else {
            $sub = $rel.Replace("/", "\")
            $cand = Join-Path $StaticDir $sub
            if ($cand.StartsWith($StaticDir) -and (Test-Path $cand -PathType Leaf)) {
                $target = $cand
            }
        }

        if ($null -eq $target) {
            $res.StatusCode = 404
            $bytes = [Text.Encoding]::UTF8.GetBytes("Not Found")
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            $res.Close()
            continue
        }

        $ext = [IO.Path]::GetExtension($target).ToLowerInvariant()
        $res.ContentType = if ($MimeTypes.ContainsKey($ext)) { $MimeTypes[$ext] } else { "application/octet-stream" }

        $fs = [IO.File]::OpenRead($target)
        try {
            $res.ContentLength64 = $fs.Length
            $fs.CopyTo($res.OutputStream)
        } finally {
            $fs.Dispose()
        }
        $res.Close()
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "[ERROR] $errMsg"
        try {
            Send-ObjectJson -Response $res -StatusCode 500 -Object @{ error = "Server Error: $errMsg" }
        } catch {}
    }
}
