# PowerShell script to npm link all packages in a monorepo workspace

# Set the packages directory as the working path
$packagesDir = Join-Path (Get-Location) "packages"

# Find all directories containing a package.json file, only one level deep
$packageDirs = Get-ChildItem -Path $packagesDir -Directory | Where-Object {
    Test-Path "$($_.FullName)\package.json"
}

# Loop through each package directory and run npm link
foreach ($dir in $packageDirs) {
    Write-Host "Linking package in directory: $($dir.FullName)"
    Set-Location -Path $dir.FullName
    npm link
}

# Return to the workspace root
Set-Location -Path (Get-Location)

Write-Host "All packages have been linked successfully."