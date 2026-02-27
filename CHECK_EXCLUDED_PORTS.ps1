# Check if port 5180 is in Windows excluded port range

Write-Host "=== Checking IPv4 excluded port ranges ===" -ForegroundColor Cyan
netsh interface ipv4 show excludedportrange protocol=tcp | findstr 5180

Write-Host "`n=== Checking IPv6 excluded port ranges ===" -ForegroundColor Cyan
netsh interface ipv6 show excludedportrange protocol=tcp | findstr 5180

Write-Host "`n=== Full IPv4 excluded ranges ===" -ForegroundColor Yellow
netsh interface ipv4 show excludedportrange protocol=tcp

Write-Host "`n=== Full IPv6 excluded ranges ===" -ForegroundColor Yellow
netsh interface ipv6 show excludedportrange protocol=tcp
