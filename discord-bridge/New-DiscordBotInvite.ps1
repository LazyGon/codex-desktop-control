[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{15,22}$')]
    [string]$ApplicationId,

    [ValidatePattern('^\d{15,22}$')]
    [string]$GuildId,

    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Manage Channels, Manage Roles, Manage Messages, View Channels, Send Messages,
# Embed Links, Attach Files, and Read Message History. Manage Roles is required
# to create private category permission overwrites; Manage Messages lets an
# accepted Discord instruction be replaced by its durable user card.
$permissions = '268561424'
$url = "https://discord.com/oauth2/authorize?client_id=$ApplicationId&permissions=$permissions&integration_type=0&scope=bot+applications.commands"
if ($GuildId) {
    $url += "&guild_id=$GuildId&disable_guild_select=true"
}
Set-Clipboard -Value $url
if (-not $NoBrowser) {
    Start-Process $url
}

[pscustomobject]@{
    ApplicationId = $ApplicationId
    GuildId = $GuildId
    Permissions = $permissions
    InviteUrl = $url
    CopiedToClipboard = $true
    BrowserOpened = -not $NoBrowser
}
