Set-StrictMode -Version Latest

function Set-TypeSafeApiKeyEnvironment {
    param(
        [Parameter(Mandatory)][string]$ApiKeyText,
        [ValidateSet('User', 'Process')][string]$Target = 'User'
    )
    $normalized = $ApiKeyText.Trim()
    if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -match '[\s\p{C}]') {
        throw 'INVALID_KEY_FORMAT'
    }
    try {
        $scope = [EnvironmentVariableTarget]$Target
        [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $normalized, $scope)
        if ([Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', $scope) -cne $normalized) {
            throw 'ENVIRONMENT_READBACK_FAILED'
        }
        [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $normalized, 'Process')
    }
    finally { $normalized = $null }
}
