# 打包脚本：生成提交给老师的压缩包
# 包含：全部代码 + data.json + chroma_db/ + public/资料/
# 排除：node_modules/、.git/、*.log、.DS_Store

$src = "C:\Users\DELL\Desktop\rag-backend"
$tmp = "C:\Users\DELL\Desktop\_rag-submit-tmp"
$out = "C:\Users\DELL\Desktop\rag-backend-submit.zip"

Write-Host "📦 开始打包..." -ForegroundColor Cyan

# 清理旧的临时目录
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }

# 用 robocopy 复制，排除 node_modules
robocopy $src $tmp /E /XD "node_modules" ".git" /XF "*.log" ".DS_Store" "~$*" /NFL /NDL /NJH /NJS | Out-Null

Write-Host "✅ 文件复制完成，开始压缩..." -ForegroundColor Green

# 删除旧的 zip
if (Test-Path $out) { Remove-Item $out -Force }

# 优先用 7-Zip（压缩率更高），没有则用 PowerShell 内置
$sevenZip = @(
    "C:\Program Files\7-Zip\7z.exe",
    "C:\Program Files (x86)\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($sevenZip) {
    Write-Host "🔧 使用 7-Zip 压缩（高压缩率）..." -ForegroundColor Cyan
    & $sevenZip a -tzip -mx=5 $out "$tmp\*" | Out-Null
} else {
    Write-Host "🔧 使用 PowerShell 内置压缩..." -ForegroundColor Cyan
    Compress-Archive -Path "$tmp\*" -DestinationPath $out -CompressionLevel Optimal
}

# 清理临时目录
Remove-Item $tmp -Recurse -Force

$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "✅ 打包完成！" -ForegroundColor Green
Write-Host "📁 输出文件：$out" -ForegroundColor Yellow
Write-Host "📊 文件大小：${size} MB" -ForegroundColor Yellow
Write-Host ""
Write-Host "⚠️  注意：.env 文件已包含在包内（含 API Key），发给老师前请确认是否需要替换为示例值。" -ForegroundColor Red
